import { Component, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { SettingsService } from '../../services/settings.service';

@Component({
  selector: 'app-settings',
  imports: [MatIconModule],
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class Settings {
  protected readonly settingsService = inject(SettingsService);

  protected onPreRollInput(event: Event): void {
    this.settingsService.update({ preRollSeconds: Number((event.target as HTMLInputElement).value) });
  }

  protected onPostRollInput(event: Event): void {
    this.settingsService.update({ postRollSeconds: Number((event.target as HTMLInputElement).value) });
  }

  protected onSensitivityInput(event: Event): void {
    this.settingsService.update({ micSensitivity: Number((event.target as HTMLInputElement).value) });
  }

  protected onAutoplayDelayInput(event: Event): void {
    this.settingsService.update({ autoplayDelaySeconds: Number((event.target as HTMLInputElement).value) });
  }
}
