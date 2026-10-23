import { DatePipe } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { StrategyStore } from '../../core/strategy-store';

@Component({
  selector: 'app-home',
  imports: [FormsModule, DatePipe],
  template: `
    <div class="page">
      <div class="card">
        <h2>New strategy</h2>
        <div class="row">
          <input [(ngModel)]="name" placeholder="e.g. Spa 6h – Hypercar" (keyup.enter)="create()" style="width: 320px" />
          <button class="btn primary" (click)="create()">Create</button>
          <span class="spacer"></span>
          <label class="btn">
            Import JSON
            <input type="file" accept=".json,application/json" hidden (change)="importFile($event)" />
          </label>
        </div>
        @if (error()) {
          <div class="alert error" style="margin: 12px 0 0">{{ error() }}</div>
        }
      </div>

      <div class="card">
        <h2>My strategies</h2>
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
  private readonly router = inject(Router);
  protected name = '';
  protected readonly error = signal<string | null>(null);
  protected readonly confirmDelete = signal<string | null>(null);

  ngOnInit(): void {
    this.store.refreshList();
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
