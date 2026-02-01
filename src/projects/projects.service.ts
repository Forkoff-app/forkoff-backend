import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Project } from '@prisma/client';
import { CreateProjectDto, UpdateProjectDto } from './dto';
import { SubscriptionService } from '../subscription/subscription.service';

// Mock file tree structure for now (will be provided by CLI later)
export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  language?: string;
  children?: FileNode[];
}

@Injectable()
export class ProjectsService {
  constructor(
    private prisma: PrismaService,
    private subscriptionService: SubscriptionService,
  ) {}

  // Get all projects for a user
  async findAll(userId: string): Promise<Project[]> {
    return this.prisma.project.findMany({
      where: { userId },
      include: {
        device: {
          select: {
            id: true,
            name: true,
            status: true,
          },
        },
      },
      orderBy: { lastModified: 'desc' },
    });
  }

  // Get projects for a specific device
  async findByDevice(userId: string, deviceId: string): Promise<Project[]> {
    return this.prisma.project.findMany({
      where: {
        userId,
        deviceId,
      },
      orderBy: { lastModified: 'desc' },
    });
  }

  // Get a single project
  async findOne(userId: string, projectId: string): Promise<Project> {
    const project = await this.prisma.project.findFirst({
      where: {
        id: projectId,
        userId,
      },
      include: {
        device: {
          select: {
            id: true,
            name: true,
            status: true,
            platform: true,
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    return project;
  }

  // Create a new project
  async create(userId: string, data: CreateProjectDto): Promise<Project> {
    // Verify the device belongs to the user
    const device = await this.prisma.device.findFirst({
      where: {
        id: data.deviceId,
        userId,
      },
    });

    if (!device) {
      throw new ForbiddenException('Device not found or not owned by user');
    }

    // Check project limit
    const projectCount = await this.prisma.project.count({ where: { userId } });
    const limits = await this.subscriptionService.getLimitsForUser(userId);

    if (projectCount >= limits.maxProjects) {
      throw new ForbiddenException('PROJECT_LIMIT_REACHED');
    }

    return this.prisma.project.create({
      data: {
        ...data,
        userId,
      },
      include: {
        device: {
          select: {
            id: true,
            name: true,
            status: true,
          },
        },
      },
    });
  }

  // Update a project
  async update(
    userId: string,
    projectId: string,
    data: UpdateProjectDto,
  ): Promise<Project> {
    // Verify ownership
    await this.findOne(userId, projectId);

    return this.prisma.project.update({
      where: { id: projectId },
      data: {
        ...data,
        lastModified: new Date(),
      },
      include: {
        device: {
          select: {
            id: true,
            name: true,
            status: true,
          },
        },
      },
    });
  }

  // Delete a project
  async remove(userId: string, projectId: string): Promise<void> {
    // Verify ownership
    await this.findOne(userId, projectId);

    await this.prisma.project.delete({
      where: { id: projectId },
    });
  }

  // Get file tree for a project (mocked for now - will come from CLI via WebSocket)
  async getFileTree(
    userId: string,
    projectId: string,
    path: string = '/',
  ): Promise<FileNode[]> {
    // Verify ownership
    await this.findOne(userId, projectId);

    // This will be replaced with real data from the device via WebSocket
    // For now, return a mock structure
    return [
      {
        name: 'src',
        path: '/src',
        type: 'directory',
        children: [
          {
            name: 'index.ts',
            path: '/src/index.ts',
            type: 'file',
            language: 'typescript',
          },
          {
            name: 'App.tsx',
            path: '/src/App.tsx',
            type: 'file',
            language: 'typescriptreact',
          },
        ],
      },
      {
        name: 'package.json',
        path: '/package.json',
        type: 'file',
        language: 'json',
      },
    ];
  }

  // Get file content (will come from CLI via WebSocket)
  async getFileContent(
    userId: string,
    projectId: string,
    filePath: string,
  ): Promise<{ content: string; language: string }> {
    // Verify ownership
    await this.findOne(userId, projectId);

    // This will be replaced with real data from the device via WebSocket
    return {
      content: `// Content of ${filePath}\n\nexport const example = "Hello World";\n`,
      language: this.detectLanguage(filePath),
    };
  }

  private detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const languageMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescriptreact',
      js: 'javascript',
      jsx: 'javascriptreact',
      py: 'python',
      rs: 'rust',
      go: 'go',
      java: 'java',
      kt: 'kotlin',
      swift: 'swift',
      rb: 'ruby',
      json: 'json',
      md: 'markdown',
      yaml: 'yaml',
      yml: 'yaml',
      html: 'html',
      css: 'css',
      scss: 'scss',
    };
    return languageMap[ext || ''] || 'plaintext';
  }

  // Update last modified timestamp
  async touch(projectId: string): Promise<void> {
    await this.prisma.project.update({
      where: { id: projectId },
      data: { lastModified: new Date() },
    });
  }
}
