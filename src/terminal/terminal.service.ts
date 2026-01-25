import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Terminal sessions are ephemeral - stored in memory, not database
// Commands are relayed to devices via WebSocket

export interface TerminalSession {
  id: string;
  userId: string;
  deviceId: string;
  workingDirectory: string;
  createdAt: Date;
  lastActivityAt: Date;
}

@Injectable()
export class TerminalService {
  private sessions: Map<string, TerminalSession> = new Map();

  constructor(private prisma: PrismaService) {}

  // Create a new terminal session
  async createSession(
    userId: string,
    deviceId: string,
    workingDirectory?: string,
  ): Promise<TerminalSession> {
    // Verify user owns the device
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, userId },
    });

    if (!device) {
      throw new NotFoundException('Device not found');
    }

    const session: TerminalSession = {
      id: this.generateSessionId(),
      userId,
      deviceId,
      workingDirectory: workingDirectory || '~',
      createdAt: new Date(),
      lastActivityAt: new Date(),
    };

    this.sessions.set(session.id, session);
    return session;
  }

  // Get a terminal session
  getSession(userId: string, sessionId: string): TerminalSession {
    const session = this.sessions.get(sessionId);

    if (!session || session.userId !== userId) {
      throw new NotFoundException('Terminal session not found');
    }

    return session;
  }

  // Get all active terminal sessions for a user
  getUserSessions(userId: string): TerminalSession[] {
    return Array.from(this.sessions.values()).filter(
      (session) => session.userId === userId,
    );
  }

  // Get terminal sessions for a specific device
  getDeviceSessions(userId: string, deviceId: string): TerminalSession[] {
    return Array.from(this.sessions.values()).filter(
      (session) => session.userId === userId && session.deviceId === deviceId,
    );
  }

  // Update session activity timestamp
  updateActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = new Date();
    }
  }

  // Update working directory
  updateWorkingDirectory(sessionId: string, directory: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.workingDirectory = directory;
    }
  }

  // Close a terminal session
  closeSession(userId: string, sessionId: string): boolean {
    const session = this.sessions.get(sessionId);

    if (!session || session.userId !== userId) {
      return false;
    }

    this.sessions.delete(sessionId);
    return true;
  }

  // Clean up stale sessions (called periodically)
  cleanupStaleSessions(maxIdleMinutes = 30): number {
    const cutoff = new Date(Date.now() - maxIdleMinutes * 60 * 1000);
    let cleaned = 0;

    for (const [id, session] of this.sessions.entries()) {
      if (session.lastActivityAt < cutoff) {
        this.sessions.delete(id);
        cleaned++;
      }
    }

    return cleaned;
  }

  private generateSessionId(): string {
    return `term_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
