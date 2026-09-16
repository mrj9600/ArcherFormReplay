import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { SessionService } from '../../services/session.service';

@Component({
  selector: 'app-session',
  imports: [MatButtonModule, MatIconModule],
  templateUrl: './session.html',
  styleUrl: './session.scss',
})
export class Session {
  protected readonly session = inject(SessionService);
  protected readonly joinCode = signal('');
  protected readonly busy = signal(false);

  protected async startMaster(): Promise<void> {
    this.busy.set(true);
    try {
      await this.session.startMaster();
    } catch {
      // error() signal already reflects the failure.
    } finally {
      this.busy.set(false);
    }
  }

  protected async joinAsSlave(): Promise<void> {
    if (!this.joinCode().trim()) return;
    this.busy.set(true);
    try {
      await this.session.joinAsSlave(this.joinCode());
    } catch {
      // error() signal already reflects the failure.
    } finally {
      this.busy.set(false);
    }
  }

  protected onJoinCodeInput(event: Event): void {
    this.joinCode.set((event.target as HTMLInputElement).value);
  }

  protected leave(): void {
    this.session.leaveSession();
    this.joinCode.set('');
  }
}
