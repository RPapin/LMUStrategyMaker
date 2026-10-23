import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { newDriver } from '../../core/defaults';
import { setAvailability } from '../../core/engine/assign';
import { AvailabilityWindow, Driver } from '../../core/models';
import { StrategyStore } from '../../core/strategy-store';
import { startEpoch, toLocalInput } from '../../core/util';

@Component({
  selector: 'app-drivers-tab',
  imports: [FormsModule],
  template: `
    @if (draft(); as d) {
      <div class="row" style="margin-bottom: 12px">
        <span class="muted small">
          Availability can also be set stint by stint in the Strategy tab. Times are real local times.
        </span>
        <span class="spacer"></span>
        <button class="btn primary" (click)="add()">+ Add driver</button>
      </div>

      @for (drv of d.drivers; track drv.id) {
        <div class="card" (input)="store.touch()" (change)="store.touch()">
          <div class="row" style="margin-bottom: 12px">
            <input type="color" [(ngModel)]="drv.color" />
            <input [(ngModel)]="drv.name" style="font-weight: 600; width: 220px" />
            <label class="field inline"><input type="checkbox" [(ngModel)]="drv.canSpot" /> Can spot</label>
            @if (store.isCloud()) {
              <label class="field inline">
                Team member
                <select [ngModel]="store.links()[drv.id] ?? null" (ngModelChange)="store.linkDriver(drv.id, $event)">
                  <option [ngValue]="null">— not linked —</option>
                  @for (m of store.members(); track m.user_id) {
                    <option [ngValue]="m.user_id">{{ m.display_name }}</option>
                  }
                </select>
              </label>
            }
            <span class="spacer"></span>
            <button class="btn sm danger" (click)="remove(drv)">Remove</button>
          </div>
          <div class="grid">
            <label class="field">Min driving time (min)
              <input type="number" min="0" [(ngModel)]="drv.minDriveMin" placeholder="none" />
            </label>
            <label class="field">Max driving time (min)
              <input type="number" min="0" [(ngModel)]="drv.maxDriveMin" placeholder="none" />
            </label>
            <label class="field">Max stints in a row
              <input type="number" min="0" [(ngModel)]="drv.maxConsecutiveStints" />
              <span class="small">0 = no limit</span>
            </label>
            <label class="field">Min rest between stints (min)
              <input type="number" min="0" [(ngModel)]="drv.minRestMin" />
            </label>
          </div>

          <div class="row" style="margin: 16px 0 8px">
            <h3 style="margin: 0">Availability</h3>
            <span class="muted small">Available the whole race unless a window says otherwise.</span>
            <span class="spacer"></span>
            <button class="btn sm" (click)="addWindow(drv)">+ Add window</button>
          </div>
          @for (w of drv.availability; track $index) {
            <div class="row" style="margin-bottom: 6px">
              <select [ngModel]="w.status" (ngModelChange)="w.status = $event; store.availabilityChanged(drv)">
                <option value="unavailable">Unavailable</option>
                <option value="preferred">Preferred</option>
              </select>
              from
              <input type="datetime-local" [ngModel]="local(w.from)" (ngModelChange)="setFrom(drv, w, $event)" />
              to
              <input type="datetime-local" [ngModel]="local(w.to)" (ngModelChange)="setTo(drv, w, $event)" />
              <button class="btn sm danger" (click)="removeWindow(drv, w)">Remove</button>
            </div>
          }
        </div>
      } @empty {
        <div class="card muted">No driver yet.</div>
      }
    }
  `,
})
export class DriversTab {
  protected readonly store = inject(StrategyStore);
  protected readonly draft = computed(() => this.store.current()?.draft ?? null);
  protected readonly local = toLocalInput;

  add(): void {
    const d = this.draft()!;
    d.drivers.push(newDriver(d.drivers.length));
    this.store.touch();
  }

  remove(drv: Driver): void {
    const d = this.draft()!;
    d.drivers = d.drivers.filter((x) => x !== drv);
    for (const a of d.assignments) {
      if (a.driverId === drv.id) Object.assign(a, { driverId: null, driverLocked: false });
      if (a.spotterId === drv.id) Object.assign(a, { spotterId: null, spotterLocked: false });
    }
    this.store.touch();
  }

  addWindow(drv: Driver): void {
    const start = startEpoch(this.draft()!.race.startTime);
    const from = drv.availability.length ? drv.availability[drv.availability.length - 1].to : start;
    drv.availability.push({ from, to: from + 2 * 3600_000, status: 'unavailable' });
    this.store.availabilityChanged(drv);
  }

  removeWindow(drv: Driver, w: AvailabilityWindow): void {
    drv.availability = drv.availability.filter((x) => x !== w);
    this.store.availabilityChanged(drv);
  }

  setFrom(drv: Driver, w: AvailabilityWindow, v: string): void {
    const t = new Date(v).getTime();
    if (!isNaN(t)) this.replace(drv, w, t, Math.max(t, w.to));
  }

  setTo(drv: Driver, w: AvailabilityWindow, v: string): void {
    const t = new Date(v).getTime();
    if (!isNaN(t)) this.replace(drv, w, Math.min(w.from, t), t);
  }

  /** Re-insert so overlapping windows get split / merged consistently. */
  private replace(drv: Driver, w: AvailabilityWindow, from: number, to: number): void {
    drv.availability = drv.availability.filter((x) => x !== w);
    setAvailability(drv, from, to, w.status);
    this.store.availabilityChanged(drv);
  }
}
