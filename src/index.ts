import { Octokit, type RestEndpointMethodTypes } from "@octokit/rest";
import type { RESTPostAPIWebhookWithTokenJSONBody } from "discord-api-types/v10";
import { EmbedBuilder } from "@discordjs/builders";
import { env } from "./env";

const log = env.DEBUG ? console.log : () => void 0;

class GitHubRelease {
  private readonly name: string;
  private readonly time: Date;
  private readonly url: string;
  private readonly body: string;
  private readonly isPrerelease: boolean;
  private readonly author: { username: string; photo: string };

  private static readonly STABLE_COLOUR = 0x0072f7;
  private static readonly PRERELEASE_COLOUR = 0xffb11a;

  public constructor(
    release: RestEndpointMethodTypes["repos"]["listReleases"]["response"]["data"][number],
  ) {
    this.name = release.name ?? "Release name not provided";
    this.time = release.published_at ? new Date(release.published_at) : new Date();
    this.url = release.html_url;
    this.body = release.body ?? "Release body not provided";
    this.isPrerelease = release.prerelease;
    this.author = {
      username: release.author.login,
      photo: release.author.avatar_url,
    };
  }

  private getMessageContent() {
    if (this.isPrerelease) {
      return env.PRERELEASE_PING_ROLE_ID
        ? `<@&${env.PRERELEASE_PING_ROLE_ID}>: ${this.name}`
        : `New prerelease: ${this.name}`;
    }
    return env.RELEASE_PING_ROLE_ID
      ? `<@&${env.RELEASE_PING_ROLE_ID}>: ${this.name}`
      : `New release: ${this.name}`;
  }

  private getEmbedTitle() {
    return this.isPrerelease ? `🚧 ${this.name}` : `📦 ${this.name}`;
  }

  private getEmbedBody() {
    const repoLink = `https://github.com/${env.REPO_OWNER}/${env.REPO_NAME}`;

    const markdown = this.body
      // PR number: #123
      .replace(/#(\d+)/g, `[#$1](${repoLink}/pull/$1)`)
      // Username: @test
      .split("Credits")
      .map((value, index) =>
        index === 1 ? value.replace(/@([a-zA-Z0-9-]+)/g, `[@$1](https://github.com/$1)`) : value,
      )
      .join("Credits")
      // Commit hash
      .replace(
        /[a-f0-9]{40}/g,
        value => `[${value.substring(0, 7)}](${repoLink}/commit/${value})`,
      )
      // Remove blank lines
      .replace(/\n+/g, "\n");

    // Embed footer doesn't support links :sad_cri:
    const footer = `\n**[View the release note on GitHub](${this.url})**`;

    const BODY_MAX_LENGTH = 4096 - footer.length;
    return markdown.length > BODY_MAX_LENGTH
      ? `${markdown.substring(0, BODY_MAX_LENGTH - 1)}…${footer}`
      : markdown + footer;
  }

  private getEmbedColour() {
    return this.isPrerelease ? GitHubRelease.PRERELEASE_COLOUR : GitHubRelease.STABLE_COLOUR;
  }

  public getTitle() {
    return this.name;
  }

  public getTime() {
    return this.time;
  }

  public getMessage(): RESTPostAPIWebhookWithTokenJSONBody {
    return {
      content: this.getMessageContent(),
      embeds: [
        new EmbedBuilder()
          .setTitle(this.getEmbedTitle())
          .setURL(this.url)
          .setDescription(this.getEmbedBody())
          .setFooter({ text: `Released by @${this.author.username}`, iconURL: this.author.photo })
          .setTimestamp(this.time)
          .setColor(this.getEmbedColour())
          .toJSON(),
      ],
    };
  }
}

class LastUpdatedStore {
  private readonly lastUpdated: Date;
  public constructor() {
    this.lastUpdated = new Date();
  }
  public releaseIsNewer(release: GitHubRelease): boolean {
    return release.getTime() > this.lastUpdated;
  }
  public update(): void {
    this.lastUpdated.setTime(Date.now());
  }
}

class ReleaseChecker {
  private readonly octokit = new Octokit({ auth: env.GITHUB_TOKEN });
  private readonly lastUpdatedStore = new LastUpdatedStore();

  options = {
    maxItems: 2,
    revalidate: 1000 * 60, // 1 minute
  };

  async getNewReleases(): Promise<GitHubRelease[]> {
    const res = await this.octokit.repos.listReleases({
      owner: env.REPO_OWNER,
      repo: env.REPO_NAME,
    });

    if (process.env.NODE_ENV === "development")
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- choose a repo that already has releases
      return [new GitHubRelease(res.data[0]!)];

    return res.data
      .map(release => new GitHubRelease(release))
      .filter(release => this.lastUpdatedStore.releaseIsNewer(release))
      .sort((a, b) => b.getTime().valueOf() - a.getTime().valueOf()) // recent first
      .slice(0, this.options.maxItems)
      .reverse(); // we need to post the oldest first
  }

  async postNewRelease(release: GitHubRelease) {
    await fetch(env.DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(release.getMessage()),
    });
  }

  async check() {
    log("Checking for new releases at", new Date().toISOString());
    const releases = await this.getNewReleases();
    for (const release of releases) {
      log("Posting release", release.getTitle());
      // eslint-disable-next-line no-await-in-loop -- We want to ensure the order is correct
      await this.postNewRelease(release);
    }
    this.lastUpdatedStore.update();
  }

  public async run() {
    await this.check();
    setInterval(() => void this.check(), this.options.revalidate);
  }
}

new ReleaseChecker().run();
