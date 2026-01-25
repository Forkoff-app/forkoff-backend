import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreateRepoDto, CloneRepoDto } from './dto';

// GitHub API response types
export interface GithubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  updated_at: string;
  owner: {
    login: string;
    avatar_url: string;
  };
}

export interface GithubBranch {
  name: string;
  commit: {
    sha: string;
    url: string;
  };
  protected: boolean;
}

export interface GithubUser {
  login: string;
  id: number;
  avatar_url: string;
  name: string | null;
  email: string | null;
  bio: string | null;
  public_repos: number;
  followers: number;
  following: number;
}

// In-memory token storage (replace with database in production)
// Key: userId, Value: access token
const tokenStore = new Map<string, string>();

@Injectable()
export class GithubService {
  private readonly githubApiUrl = 'https://api.github.com';

  constructor(private configService: ConfigService) {}

  // Store GitHub token for user (called after OAuth flow)
  storeToken(userId: string, accessToken: string): void {
    tokenStore.set(userId, accessToken);
  }

  // Get stored token for user
  private getToken(userId: string): string {
    const token = tokenStore.get(userId);
    if (!token) {
      throw new UnauthorizedException(
        'GitHub not connected. Please authenticate with GitHub first.',
      );
    }
    return token;
  }

  // Check if user has GitHub connected
  hasGithubConnected(userId: string): boolean {
    return tokenStore.has(userId);
  }

  // Remove GitHub connection
  disconnectGithub(userId: string): void {
    tokenStore.delete(userId);
  }

  // Make authenticated request to GitHub API
  private async githubFetch<T>(
    userId: string,
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const token = this.getToken(userId);

    const response = await fetch(`${this.githubApiUrl}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...options.headers,
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        tokenStore.delete(userId);
        throw new UnauthorizedException(
          'GitHub token expired. Please reconnect GitHub.',
        );
      }
      const error = await response.text();
      throw new BadRequestException(`GitHub API error: ${error}`);
    }

    return response.json() as Promise<T>;
  }

  // Get authenticated user's GitHub profile
  async getProfile(userId: string): Promise<GithubUser> {
    return this.githubFetch<GithubUser>(userId, '/user');
  }

  // List user's repositories
  async listRepos(
    userId: string,
    options?: {
      page?: number;
      perPage?: number;
      sort?: 'updated' | 'created' | 'pushed' | 'full_name';
      type?: 'all' | 'owner' | 'public' | 'private' | 'member';
    },
  ): Promise<GithubRepo[]> {
    const params = new URLSearchParams();
    params.append('page', String(options?.page || 1));
    params.append('per_page', String(options?.perPage || 30));
    params.append('sort', options?.sort || 'updated');
    params.append('type', options?.type || 'all');

    return this.githubFetch<GithubRepo[]>(
      userId,
      `/user/repos?${params.toString()}`,
    );
  }

  // Get a specific repository
  async getRepo(userId: string, fullName: string): Promise<GithubRepo> {
    return this.githubFetch<GithubRepo>(userId, `/repos/${fullName}`);
  }

  // Get repository branches
  async getBranches(userId: string, fullName: string): Promise<GithubBranch[]> {
    return this.githubFetch<GithubBranch[]>(
      userId,
      `/repos/${fullName}/branches`,
    );
  }

  // Create a new repository
  async createRepo(userId: string, data: CreateRepoDto): Promise<GithubRepo> {
    return this.githubFetch<GithubRepo>(userId, '/user/repos', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: data.name,
        description: data.description,
        private: data.isPrivate ?? false,
        auto_init: data.autoInit ?? true,
      }),
    });
  }

  // Generate clone command (to be sent to device via WebSocket)
  generateCloneCommand(
    repo: GithubRepo,
    destinationPath: string,
    branch?: string,
  ): string {
    let command = `git clone ${repo.clone_url} "${destinationPath}"`;
    if (branch && branch !== repo.default_branch) {
      command += ` --branch ${branch}`;
    }
    return command;
  }

  // Prepare clone operation data
  async prepareClone(
    userId: string,
    data: CloneRepoDto,
  ): Promise<{
    repo: GithubRepo;
    command: string;
    deviceId: string;
    destinationPath: string;
  }> {
    const repo = await this.getRepo(userId, data.repoFullName);

    const command = this.generateCloneCommand(
      repo,
      data.destinationPath,
      data.branch,
    );

    return {
      repo,
      command,
      deviceId: data.deviceId,
      destinationPath: data.destinationPath,
    };
  }

  // Search repositories
  async searchRepos(
    userId: string,
    query: string,
    options?: { page?: number; perPage?: number },
  ): Promise<{ total_count: number; items: GithubRepo[] }> {
    const params = new URLSearchParams();
    params.append('q', query);
    params.append('page', String(options?.page || 1));
    params.append('per_page', String(options?.perPage || 30));

    return this.githubFetch<{ total_count: number; items: GithubRepo[] }>(
      userId,
      `/search/repositories?${params.toString()}`,
    );
  }
}
