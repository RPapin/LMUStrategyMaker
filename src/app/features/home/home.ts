import { DatePipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CloudRepo, TeamSummary } from '../../core/cloud/cloud-repo';
import { Supabase } from '../../core/cloud/supabase';
import { StrategyStore } from '../../core/strategy-store';

@Component({
  selector: 'app-home',
  imports: [FormsModule, DatePipe, RouterLink],
  styles: `.sm-select { padding: 3px 6px; font-size: 12px; max-width: 140px; }`,
  template: `
    <div class="page">
      @if (error()) {
        <div class="alert error">{{ error() }}</div>
      }
      @if (sb.configured) {
        <div class="card">
          <h2>My teams</h2>
          @if (sb.user()) {
            @if (teams().length) {
              <table class="data" style="margin-bottom: 12px">
                <thead><tr><th>Team</th><th>Role</th></tr></thead>
                <tbody>
                  @for (t of teams(); track t.id) {
                    <tr>
                      <td><a [routerLink]="['/team', t.id]">{{ t.name }}</a></td>
                      <td class="muted">{{ t.role }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <p class="muted small">No team yet. Create one, or open an invite link from a teammate.</p>
            }
            <div class="row">
              <input [(ngModel)]="teamName" placeholder="Team name" (keyup.enter)="createTeam()" style="width: 260px" />
              <button class="btn" (click)="createTeam()" [disabled]="!teamName.trim()">Create team</button>
            </div>
          } @else {
            <p class="muted">Sign in to share strategies with your team and let drivers set their availability.</p>
            <a class="btn primary" routerLink="/login">Sign in</a>
          }
        </div>
      }

      <div class="card">
        <h2>New local strategy</h2>
        <p class="muted small" style="margin-top: -6px">Stored in this browser only. You can upload it to a team later.</p>
        <div class="row">
          <input [(ngModel)]="name" placeholder="e.g. Spa 6h – Hypercar" (keyup.enter)="create()" style="width: 320px" />
          <button class="btn primary" (click)="create()">Create</button>
          <span class="spacer"></span>
          <label class="btn">
            Import JSON
            <input type="file" accept=".json,application/json" hidden (change)="importFile($event)" />
          </label>
        </div>
      </div>

      <div class="card">
        <h2>Local strategies</h2>
        @if (store.list().length) {
          <table class="data">
            <thead>
              <tr><th>Name</th><th>Versions</th><th>Updated</th><th></th></tr>
            </thead>
            <tbody>
              @for (s of store.list(); track s.id) {
                <tr>
                  <td><a href="" (click)="$event.preventDefault(); open(s.id)">{{ s.name }}</a></td>
                  <td class="num">{{ s.versions.length }}</td>
                  <td class="muted">{{ s.updatedAt | date: 'short' }}</td>
                  <td style="text-align: right">
                    @if (teams().length) {
                      <select #team class="sm-select">
                        @for (t of uploadTeams(); track t.id) { <option [value]="t.id">{{ t.name }}</option> }
                      </select>
                      <button class="btn sm" (click)="upload(s.id, team.value)" [disabled]="!uploadTeams().length">
                        Upload to team
                      </button>
                    }
                    <button class="btn sm" (click)="duplicate(s.id)">Duplicate</button>
                    @if (confirmDelete() === s.id) {
                      <button class="btn sm danger" (click)="store.remove(s.id)">Confirm delete</button>
                      <button class="btn sm ghost" (click)="confirmDelete.set(null)">Cancel</button>
                    } @else {
                      <button class="btn sm danger" (click)="confirmDelete.set(s.id)">Delete</button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <p class="muted">No strategy yet. Create one above; it starts with example LMU Hypercar values.</p>
        }
      </div>
    </div>
  `,
})
export class Home implements OnInit {
  protected readonly store = inject(StrategyStore);
  protected readonly sb = inject(Supabase);
  private readonly cloud = inject(CloudRepo);
  protected readonly teams = signal<TeamSummary[]>([]);
  protected teamName = '';
  private readonly router = inject(Router);
  protected name = '';
  protected readonly error = signal<string | null>(null);
  protected readonly confirmDelete = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    this.store.refreshList();
    await this.sb.whenReady();
    if (this.sb.user()) await this.run(async () => this.teams.set(await this.cloud.myTeams()));
  }

  protected uploadTeams(): TeamSummary[] {
    return this.teams().filter((t) => t.role !== 'driver');
  }

  async createTeam(): Promise<void> {
    await this.run(async () => {
      const id = await this.cloud.createTeam(this.teamName.trim());
      this.router.navigate(['/team', id]);
    });
  }

  async upload(localId: string, teamId: string): Promise<void> {
    await this.run(async () => {
      const id = await this.store.uploadToTeam(localId, teamId);
      this.router.navigate(['/team', teamId, 'strategy', id]);
    });
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.error.set(null);
    try {
      await fn();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }

  async create(): Promise<void> {
    const rec = await this.store.create(this.name.trim());
    this.open(rec.id);
  }

  async duplicate(id: string): Promise<void> {
    await this.store.duplicate(id);
  }

  open(id: string): void {
    this.router.navigate(['/strategy', id]);
  }

  async importFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const rec = await this.store.import(await file.text());
      this.open(rec.id);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }
}
