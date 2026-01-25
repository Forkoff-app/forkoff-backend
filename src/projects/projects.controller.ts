import {
  Controller,
  Get,
  Post,
  Patch,
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
import { ProjectsService } from './projects.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '@prisma/client';
import { CreateProjectDto, UpdateProjectDto } from './dto';

@ApiTags('projects')
@ApiBearerAuth('supabase-auth')
@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get()
  @ApiOperation({ summary: 'Get all projects for the user' })
  @ApiQuery({ name: 'deviceId', required: false, description: 'Filter by device ID' })
  @ApiResponse({ status: 200, description: 'Returns list of projects' })
  async findAll(
    @CurrentUser() user: User,
    @Query('deviceId') deviceId?: string,
  ) {
    if (deviceId) {
      return this.projectsService.findByDevice(user.id, deviceId);
    }
    return this.projectsService.findAll(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single project by ID' })
  @ApiParam({ name: 'id', description: 'Project UUID' })
  @ApiResponse({ status: 200, description: 'Returns the project' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async findOne(@CurrentUser() user: User, @Param('id') id: string) {
    return this.projectsService.findOne(user.id, id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new project' })
  @ApiResponse({ status: 201, description: 'Project created' })
  async create(@CurrentUser() user: User, @Body() data: CreateProjectDto) {
    return this.projectsService.create(user.id, data);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a project' })
  @ApiParam({ name: 'id', description: 'Project UUID' })
  @ApiResponse({ status: 200, description: 'Project updated' })
  async update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() data: UpdateProjectDto,
  ) {
    return this.projectsService.update(user.id, id, data);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a project' })
  @ApiParam({ name: 'id', description: 'Project UUID' })
  @ApiResponse({ status: 200, description: 'Project deleted' })
  async remove(@CurrentUser() user: User, @Param('id') id: string) {
    await this.projectsService.remove(user.id, id);
    return { success: true };
  }

  @Get(':id/files')
  @ApiOperation({ summary: 'Get file tree for a project' })
  @ApiParam({ name: 'id', description: 'Project UUID' })
  @ApiQuery({ name: 'path', required: false, description: 'Subdirectory path' })
  @ApiResponse({ status: 200, description: 'Returns file tree' })
  async getFileTree(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query('path') path?: string,
  ) {
    return this.projectsService.getFileTree(user.id, id, path);
  }

  @Get(':id/files/content')
  @ApiOperation({ summary: 'Get file content' })
  @ApiParam({ name: 'id', description: 'Project UUID' })
  @ApiQuery({ name: 'path', required: true, description: 'File path' })
  @ApiResponse({ status: 200, description: 'Returns file content' })
  async getFileContent(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query('path') path: string,
  ) {
    return this.projectsService.getFileContent(user.id, id, path);
  }
}
