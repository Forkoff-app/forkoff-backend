import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private resend: Resend | null = null;
  private from: string;

  constructor(private configService: ConfigService) {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    this.from =
      this.configService.get<string>('SMTP_FROM') ||
      'ForkOff <noreply@forkoff.app>';

    if (!apiKey) {
      this.logger.warn(
        'RESEND_API_KEY not configured - email sending disabled',
      );
      return;
    }

    this.resend = new Resend(apiKey);
    this.logger.log('Email service initialized (Resend)');
  }

  async sendEmail(options: EmailOptions): Promise<boolean> {
    if (!this.resend) {
      this.logger.warn('Email sending skipped - Resend not initialized');
      return false;
    }

    try {
      const { error } = await this.resend.emails.send({
        from: this.from,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
      });

      if (error) {
        this.logger.error(
          `Failed to send email to ${options.to}: ${error.message}`,
        );
        return false;
      }

      this.logger.log(`Email sent to ${options.to}: ${options.subject}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send email to ${options.to}:`, error);
      return false;
    }
  }

  async sendWaitlistConfirmation(email: string): Promise<boolean> {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Welcome to ForkOff Waitlist</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
            <tr>
              <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                  <!-- Header -->
                  <tr>
                    <td style="padding: 40px 40px 20px; text-align: center;">
                      <img src="https://forkoff.app/images/logo.png" alt="ForkOff" width="80" height="80" style="display: block; margin: 0 auto;">
                      <h1 style="margin: 20px 0 0; font-size: 28px; font-weight: 700; color: #1a1a1a;">You're on the Waitlist!</h1>
                    </td>
                  </tr>
                  <!-- Body -->
                  <tr>
                    <td style="padding: 0 40px 40px;">
                      <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">
                        Thanks for joining the ForkOff waitlist! We're excited to have you onboard.
                      </p>
                      <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">
                        ForkOff lets you control your AI coding tools from your mobile device. Code on the go, approve changes, and stay in control - all from your phone.
                      </p>
                      <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">
                        <strong>What happens next?</strong>
                      </p>
                      <ul style="margin: 0 0 20px; padding-left: 20px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">
                        <li style="margin-bottom: 8px;">We're rolling out beta access in waves</li>
                        <li style="margin-bottom: 8px;">You'll receive an email with your beta invite link</li>
                        <li style="margin-bottom: 8px;">Keep an eye on your inbox - invites are going out soon!</li>
                      </ul>
                      <div style="text-align: center; margin: 30px 0;">
                        <a href="https://forkoff.app" style="display: inline-block; padding: 14px 32px; background-color: #6366f1; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px;">Visit Website</a>
                      </div>
                      <p style="margin: 20px 0 0; font-size: 14px; line-height: 1.6; color: #6a6a6a;">
                        Questions? Reply to this email or reach us at <a href="mailto:support@forkoff.app" style="color: #6366f1; text-decoration: none;">support@forkoff.app</a>
                      </p>
                    </td>
                  </tr>
                  <!-- Footer -->
                  <tr>
                    <td style="padding: 20px 40px; border-top: 1px solid #e5e5e5; text-align: center;">
                      <p style="margin: 0; font-size: 12px; color: #9a9a9a;">
                        &copy; ${new Date().getFullYear()} ForkOff. All rights reserved.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `;

    const text = `
You're on the ForkOff Waitlist!

Thanks for joining! ForkOff lets you control your AI coding tools from your mobile device.

What happens next?
- We're rolling out beta access in waves
- You'll receive an email with your beta invite link
- Keep an eye on your inbox!

Visit: https://forkoff.app
Questions? support@forkoff.app
    `.trim();

    return this.sendEmail({
      to: email,
      subject: "You're on the ForkOff Waitlist! 🎉",
      html,
      text,
    });
  }

  async sendBetaAccessEmail(email: string): Promise<boolean> {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Your ForkOff Beta Access is Ready!</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
            <tr>
              <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                  <!-- Header -->
                  <tr>
                    <td style="padding: 40px 40px 20px; text-align: center; background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%); border-radius: 8px 8px 0 0;">
                      <img src="https://forkoff.app/images/logo.png" alt="ForkOff" width="80" height="80" style="display: block; margin: 0 auto;">
                      <h1 style="margin: 20px 0 0; font-size: 32px; font-weight: 700; color: #ffffff;">Welcome to Beta! 🚀</h1>
                    </td>
                  </tr>
                  <!-- Body -->
                  <tr>
                    <td style="padding: 40px;">
                      <p style="margin: 0 0 20px; font-size: 18px; line-height: 1.6; color: #1a1a1a; font-weight: 600;">
                        Your beta access is ready!
                      </p>
                      <p style="margin: 0 0 20px; font-size: 16px; line-height: 1.6; color: #4a4a4a;">
                        Thanks for your patience. You now have full access to ForkOff beta.
                      </p>

                      <div style="background-color: #f8f9fa; border-left: 4px solid #6366f1; padding: 20px; margin: 30px 0;">
                        <p style="margin: 0 0 16px; font-size: 16px; font-weight: 600; color: #1a1a1a;">Getting Started:</p>
                        <ol style="margin: 0; padding-left: 20px; font-size: 15px; line-height: 1.8; color: #4a4a4a;">
                          <li><strong>Download the app</strong> from the App Store (iOS) or Google Play (Android)</li>
                          <li><strong>Create your account</strong> using this email address</li>
                          <li><strong>Install the CLI</strong>: <code style="background: #e5e7eb; padding: 2px 6px; border-radius: 3px; font-family: monospace;">npm install -g forkoff</code></li>
                          <li><strong>Connect your device</strong>: Run <code style="background: #e5e7eb; padding: 2px 6px; border-radius: 3px; font-family: monospace;">forkoff pair</code> in your project</li>
                        </ol>
                      </div>

                      <div style="text-align: center; margin: 30px 0;">
                        <a href="https://forkoff.app/download" style="display: inline-block; padding: 16px 40px; background-color: #6366f1; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 18px; box-shadow: 0 4px 6px rgba(99, 102, 241, 0.25);">Download ForkOff</a>
                      </div>

                      <p style="margin: 30px 0 0; font-size: 14px; line-height: 1.6; color: #6a6a6a; padding-top: 20px; border-top: 1px solid #e5e5e5;">
                        <strong>Need help?</strong><br>
                        Check out our <a href="https://forkoff.app/docs" style="color: #6366f1; text-decoration: none;">documentation</a> or email us at <a href="mailto:support@forkoff.app" style="color: #6366f1; text-decoration: none;">support@forkoff.app</a>
                      </p>
                    </td>
                  </tr>
                  <!-- Footer -->
                  <tr>
                    <td style="padding: 20px 40px; border-top: 1px solid #e5e5e5; text-align: center;">
                      <p style="margin: 0; font-size: 12px; color: #9a9a9a;">
                        &copy; ${new Date().getFullYear()} ForkOff. All rights reserved.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `;

    const text = `
Welcome to ForkOff Beta! 🚀

Your beta access is ready. Thanks for your patience!

Getting Started:
1. Download the app from the App Store (iOS) or Google Play (Android)
2. Create your account using this email address
3. Install the CLI: npm install -g forkoff
4. Connect your device: Run 'forkoff pair' in your project

Download: https://forkoff.app/download
Documentation: https://forkoff.app/docs
Questions? support@forkoff.app
    `.trim();

    return this.sendEmail({
      to: email,
      subject: 'Welcome to ForkOff Beta! 🚀',
      html,
      text,
    });
  }
}
