import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MASTER_TRIGGER_ID } from '../../services/session-protocol';
import { SessionService } from '../../services/session.service';

@Component({
  selector: 'app-session',
  imports: [MatButtonModule, MatIconModule],
  templateUrl: './session.html',
  styleUrl: './session.scss',
})
export class Session {
  protected readonly session = inject(SessionService);
  private readonly router = inject(Router);

  protected readonly joinCode = signal('');
  protected readonly busy = signal(false);
  protected readonly masterTriggerId = MASTER_TRIGGER_ID;

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
      void this.router.navigate(['/record']);
    } catch {
      // error() signal already reflects the failure.
    } finally {
      this.busy.set(false);
    }
  }

  protected onJoinCodeInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const digitsOnly = input.value.replace(/\D/g, '').slice(0, 4);
    input.value = digitsOnly;
    this.joinCode.set(digitsOnly);
  }

  protected onTriggerDeviceChange(event: Event): void {
    this.session.setTriggerDevice((event.target as HTMLSelectElement).value);
  }

  protected onMasterRecordsVideoChange(event: Event): void {
    this.session.setMasterRecordsVideo((event.target as HTMLInputElement).checked);
  }

  protected leave(): void {
    this.session.leaveSession();
    this.joinCode.set('');
  }

  /** Master only: stops the session for everyone, not just this device (see leave()). */
  protected async stopSession(): Promise<void> {
    this.busy.set(true);
    try {
      await this.session.stopSession();
    } finally {
      this.joinCode.set('');
      this.busy.set(false);
    }
  }
}
