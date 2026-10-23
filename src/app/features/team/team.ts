import { DatePipe } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CloudRepo, Member, StrategySummary, TeamSummary } from '../../core/cloud/cloud-repo';
import { Supabase } from '../../core/cloud/supabase';
import { TeamRole } from '../../core/models';
import { StrategyStore } from '../../core/strategy-store';

@Component({
  selector: 'app-team',
  imports: [FormsModule, DatePipe, RouterLink],
  template: `
    <div class="page">
      @if (error()) {
        <div class="alert error">{{ error() }}</div>
      }
      @if (team(); as t) {
        <div class="row" style="margin-bottom: 16px">
          <a routerLink="/" class="muted">← Home</a>
          <h1 style="margin: 0 0 0 8px; font-size: 20px">{{ t.name }}</h1>
          <span class="chip">{{ roleName(t.role) }}</span>
        </div>

        <div class="card">
          <h3>Strategies</h3>
          @if (canEdit()) {
            <div class="row" style="margin-bottom: 12px">
              <input [(ngModel)]="newName" placeholder="e.g. Spa 6h" (keyup.enter)="createStrategy()" style="width: 280px" />
              <button class="btn primary" (click)="createStrategy()">New strategy</button>
            </div>
          }
          <table class="data">
            <thead><tr><th>Name</th><th>Versions</th><th>Updated</th><th></th></tr></thead>
            <tbody>
              @for (s of strategies(); track s.id) {
                <tr>
                  <td><a [routerLink]="['/team', t.id, 'strategy', s.id]">{{ s.name }}</a></td>
                  <td class="num">{{ s.versions }}</td>
                  <td class="muted">{{ s.updated_at | date: 'short' }}</td>
                  <td style="text-align: right">
                    @if (canEdit()) {
                      @if (confirmDelete() === s.id) {
                        <button class="btn sm danger" (click)="deleteStrategy(s.id)">Confirm delete</button>
                        <button class="btn sm ghost" (click)="confirmDelete.set(null)">Cancel</button>
                      } @else {
                        <button class="btn sm danger" (click)="confirmDelete.set(s.id)">Delete</button>
                      }
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="4" class="muted">No strategy yet.</td></tr>
              }
            </tbody>
          </table>
        </div>

        <div class="card">
          <h3>Members</h3>
          <div class="row" style="margin-bottom: 12px">
            <span class="muted small">Invite link (joins as driver):</span>
            <input readonly [value]="inviteUrl()" style="width: 420px" (focus)="$any($event.target).select()" />
            <button class="btn sm" (click)="copyInvite()">{{ copied() ? 'Copied' : 'Copy' }}</button>
            @if (t.role === 'owner') {
              <button class="btn sm ghost" (click)="regenerate()" title="Old link stops working">New link</button>
            }
          </div>
          <table class="data">
            <thead><tr><th>Name</th><th>Role</th><th></th></tr></thead>
            <tbody>
              @for (m of members(); track m.user_id) {
                <tr>
                  <td>{{ m.display_name }} @if (m.user_id === me()) { <span class="muted small">(you)</span> }</td>
                  <td>
                    @if (t.role === 'owner' && m.user_id !== me()) {
                      <select [ngModel]="m.role" (ngModelChange)="setRole(m, $event)">
                        <option value="owner">Owner</option>
                        <option value="editor">Editor</option>
                        <option value="driver">Driver</option>
                      </select>
                    } @else {
                      {{ roleName(m.role) }}
                    }
                  </td>
                  <td style="text-align: right">
                    @if (m.user_id === me() && t.role !== 'owner') {
                      <button class="btn sm danger" (click)="remove(m)">Leave team</button>
                    } @else if (t.role === 'owner' && m.user_id !== me()) {
                      <button class="btn sm danger" (click)="remove(m)">Remove</button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
          <p class="muted small" style="margin: 12px 0 0">
            Owner: manages members. Editor: edits strategies. Driver: sees strategies and sets their own availability.
          </p>
        </div>
      }
    </div>
  `,
})
export class TeamPage implements OnInit {
  private readonly cloud = inject(CloudRepo);
  private readonly sb = inject(Supabase);
  private readonly store = inject(StrategyStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly team = signal<TeamSummary | null>(null);
  protected readonly members = signal<Member[]>([]);
  protected readonly strategies = signal<StrategySummary[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal(false);
  protected readonly confirmDelete = signal<string | null>(null);
  protected readonly me = computed(() => this.sb.user()?.id);
  protected readonly canEdit = computed(() => this.team()?.role === 'owner' || this.team()?.role === 'editor');
  protected readonly inviteUrl = computed(() => `${location.origin}/join/${this.team()?.invite_code ?? ''}`);
  protected newName = '';

  private get teamId(): string {
    return this.route.snapshot.paramMap.get('teamId')!;
  }

  ngOnInit(): void {
    this.reload();
  }

  roleName(r: TeamRole): string {
    return { owner: 'Owner', editor: 'Editor', driver: 'Driver' }[r];
  }

  async reload(): Promise<void> {
    await this.run(async () => {
      const [team, members, strategies] = await Promise.all([
        this.cloud.team(this.teamId),
        this.cloud.members(this.teamId),
        this.cloud.listStrategies(this.teamId),
      ]);
      this.team.set(team);
      this.members.set(members);
      this.strategies.set(strategies);
    });
  }

  async createStrategy(): Promise<void> {
    await this.run(async () => {
      const id = await this.cloud.create(this.teamId, this.store.newRecord(this.newName.trim()));
      this.router.navigate(['/team', this.teamId, 'strategy', id]);
    });
  }

  async deleteStrategy(id: string): Promise<void> {
    await this.run(async () => {
      await this.cloud.remove(id);
      this.confirmDelete.set(null);
      this.strategies.set(this.strategies().filter((s) => s.id !== id));
    });
  }

  async setRole(m: Member, role: TeamRole): Promise<void> {
    await this.run(async () => {
      await this.cloud.setRole(this.teamId, m.user_id, role);
      this.members.set(this.members().map((x) => (x.user_id === m.user_id ? { ...x, role } : x)));
    });
  }

  async remove(m: Member): Promise<void> {
    await this.run(async () => {
      await this.cloud.removeMember(this.teamId, m.user_id);
      if (m.user_id === this.me()) this.router.navigate(['/']);
      else this.members.set(this.members().filter((x) => x.user_id !== m.user_id));
    });
  }

  async regenerate(): Promise<void> {
    await this.run(async () => {
      const code = await this.cloud.regenerateInvite(this.teamId);
      this.team.set({ ...this.team()!, invite_code: code });
    });
  }

  async copyInvite(): Promise<void> {
    await navigator.clipboard.writeText(this.inviteUrl());
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.error.set(null);
    try {
      await fn();
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }
}
