import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { CloudRepo } from '../../core/cloud/cloud-repo';

@Component({
  selector: 'app-join',
  imports: [RouterLink],
  template: `
    <div class="page" style="max-width: 480px; margin-top: 40px">
      <div class="card">
        @if (error()) {
          <h2>Could not join</h2>
          <div class="alert error">{{ error() }}</div>
          <a routerLink="/">Back to home</a>
        } @else {
          <p class="muted">Joining the team…</p>
        }
      </div>
    </div>
  `,
})
export class Join implements OnInit {
  private readonly cloud = inject(CloudRepo);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  protected readonly error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      const teamId = await this.cloud.joinTeam(this.route.snapshot.paramMap.get('code')!);
      this.router.navigate(['/team', teamId], { replaceUrl: true });
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
    }
  }
}
