import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { GithubService, GithubRepo, GithubBranch, GithubUser } from './github.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '@prisma/client';
import { StoreGithubTokenDto, CreateRepoDto, CloneRepoDto } from './dto';
import { WebsocketGateway } from '../websocket/websocket.gateway';

@ApiTags('github')
@ApiBearerAuth('supabase-auth')
@Controller('github')
@UseGuards(JwtAuthGuard)
export class GithubController {
  constructor(
    private readonly githubService: GithubService,
    private readonly wsGateway: WebsocketGateway,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Check if GitHub is connected' })
  @ApiResponse({ status: 200, description: 'Returns connection status' })
  async getStatus(@CurrentUser() user: User): Promise<{ connected: boolean }> {
    return {
      connected: this.githubService.hasGithubConnected(user.id),
    };
  }

  @Post('connect')
  @ApiOperation({ summary: 'Store GitHub token (after OAuth flow)' })
  @ApiResponse({ status: 200, description: 'GitHub connected successfully' })
  async connect(
    @CurrentUser() user: User,
    @Body() data: StoreGithubTokenDto,
  ): Promise<{ success: boolean }> {
    this.githubService.storeToken(user.id, data.accessToken);
    return { success: true };
  }

  @Delete('disconnect')
  @ApiOperation({ summary: 'Disconnect GitHub account' })
  @ApiResponse({ status: 200, description: 'GitHub disconnected' })
  async disconnect(@CurrentUser() user: User): Promise<{ success: boolean }> {
    this.githubService.disconnectGithub(user.id);
    return { success: true };
  }

  @Get('profile')
  @ApiOperation({ summary: 'Get GitHub user profile' })
  @ApiResponse({ status: 200, description: 'Returns GitHub profile' })
  @ApiResponse({ status: 401, description: 'GitHub not connected' })
  async getProfile(@CurrentUser() user: User): Promise<GithubUser> {
    return this.githubService.getProfile(user.id);
  }

  @Get('repos')
  @ApiOperation({ summary: 'List user repositories' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number' })
  @ApiQuery({ name: 'perPage', required: false, description: 'Items per page (default 30)' })
  @ApiQuery({ name: 'sort', required: false, enum: ['updated', 'created', 'pushed', 'full_name'] })
  @ApiQuery({ name: 'type', required: false, enum: ['all', 'owner', 'public', 'private', 'member'] })
  @ApiResponse({ status: 200, description: 'Returns list of repositories' })
  async listRepos(
    @CurrentUser() user: User,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
    @Query('sort') sort?: 'updated' | 'created' | 'pushed' | 'full_name',
    @Query('type') type?: 'all' | 'owner' | 'public' | 'private' | 'member',
  ): Promise<GithubRepo[]> {
    return this.githubService.listRepos(user.id, {
      page: page ? parseInt(page) : undefined,
      perPage: perPage ? parseInt(perPage) : undefined,
      sort,
      type,
    });
  }

  @Get('repos/:owner/:repo')
  @ApiOperation({ summary: 'Get a specific repository' })
  @ApiParam({ name: 'owner', description: 'Repository owner' })
  @ApiParam({ name: 'repo', description: 'Repository name' })
  @ApiResponse({ status: 200, description: 'Returns repository details' })
  async getRepo(
    @CurrentUser() user: User,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
  ): Promise<GithubRepo> {
    return this.githubService.getRepo(user.id, `${owner}/${repo}`);
  }

  @Get('repos/:owner/:repo/branches')
  @ApiOperation({ summary: 'Get repository branches' })
  @ApiParam({ name: 'owner', description: 'Repository owner' })
  @ApiParam({ name: 'repo', description: 'Repository name' })
  @ApiResponse({ status: 200, description: 'Returns list of branches' })
  async getBranches(
    @CurrentUser() user: User,
    @Param('owner') owner: string,
    @Param('repo') repo: string,
  ): Promise<GithubBranch[]> {
    return this.githubService.getBranches(user.id, `${owner}/${repo}`);
  }

  @Post('repos')
  @ApiOperation({ summary: 'Create a new GitHub repository' })
  @ApiResponse({ status: 201, description: 'Repository created' })
  async createRepo(
    @CurrentUser() user: User,
    @Body() data: CreateRepoDto,
  ): Promise<GithubRepo> {
    return this.githubService.createRepo(user.id, data);
  }

  @Post('clone')
  @ApiOperation({ summary: 'Clone repository to a connected device' })
  @ApiResponse({ status: 200, description: 'Clone command sent to device' })
  @ApiResponse({ status: 404, description: 'Device offline or not found' })
  async cloneRepo(
    @CurrentUser() user: User,
    @Body() data: CloneRepoDto,
  ): Promise<{ success: boolean; command: string; repo: GithubRepo }> {
    const cloneData = await this.githubService.prepareClone(user.id, data);

    if (!this.wsGateway.isDeviceOnline(data.deviceId)) {
      return {
        success: false,
        command: cloneData.command,
        repo: cloneData.repo,
      };
    }

    this.wsGateway.sendToDevice(data.deviceId, 'git_clone', {
      command: cloneData.command,
      repo: {
        fullName: cloneData.repo.full_name,
        cloneUrl: cloneData.repo.clone_url,
        defaultBranch: cloneData.repo.default_branch,
      },
      destinationPath: cloneData.destinationPath,
      requestedBy: user.id,
    });

    return {
      success: true,
      command: cloneData.command,
      repo: cloneData.repo,
    };
  }

  @Get('search')
  @ApiOperation({ summary: 'Search GitHub repositories' })
  @ApiQuery({ name: 'q', required: true, description: 'Search query' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number' })
  @ApiQuery({ name: 'perPage', required: false, description: 'Items per page' })
  @ApiResponse({ status: 200, description: 'Returns search results' })
  async searchRepos(
    @CurrentUser() user: User,
    @Query('q') query: string,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
  ): Promise<{ total_count: number; items: GithubRepo[] }> {
    return this.githubService.searchRepos(user.id, query, {
      page: page ? parseInt(page) : undefined,
      perPage: perPage ? parseInt(perPage) : undefined,
    });
  }
}
