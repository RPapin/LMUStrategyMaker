import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { availabilityFor, setAvailability, stintRealRange } from '../../core/engine/assign';
import { Availability, AvailabilityWindow, Driver } from '../../core/models';
import { StrategyStore } from '../../core/strategy-store';
import { clockAt, formatDuration, startEpoch, toLocalInput } from '../../core/util';

const NEXT: Record<Availability, Availability> = {
  available: 'preferred',
  preferred: 'unavailable',
  unavailable: 'available',
};

const LABEL: Record<Availability, string> = {
  available: 'Available',
  preferred: 'Preferred',
  unavailable: 'Unavailable',
};

/** What a team member sees for themselves: link to a driver slot, then set their availability. */
@Component({
  selector: 'app-my-availability-tab',
  imports: [FormsModule],
  template: `
    @if (draft(); as d) {
      @if (me(); as drv) {
        <div class="card">
          <div class="row" style="margin-bottom: 12px">
            <span class="dot" [style.background]="drv.color"></span>
            <h2 style="margin: 0">{{ drv.name }}</h2>
            <span class="muted small">This is you in this strategy (remembered in this browser).</span>
            <span class="spacer"></span>
            <button class="btn sm ghost" (click)="store.setMe(null)">Not me</button>
          </div>

          @if (plan(); as p) {
            <h3>By stint</h3>
            <p class="muted small">Click a stint to cycle available → preferred → unavailable.</p>
            <div class="stints">
              @for (s of p.stints; track s.index) {
                @let st = status(drv, s.index);
                <button class="stint {{ st }}" (click)="cycle(drv, s.index, st)">
                  <b>{{ s.index + 1 }}</b>
                  <span class="num">{{ clock(s.startSec, true) }}–{{ clock(s.endSec) }}</span>
                  <span class="small">{{ label[st] }}</span>
                  @if (d.assignments[s.index]?.driverId === drv.id) {
                    <span class="chip small">driving</span>
                  } @else if (d.assignments[s.index]?.spotterId === drv.id) {
                    <span class="chip small">spotting</span>
                  }
                </button>
              }
            </div>
            <p class="muted small">
              You drive {{ duration(driveSec(drv)) }} in the current plan. The strategist re-balances the crew with your
              availability.
            </p>
          }

          <div class="row" style="margin: 16px 0 8px">
            <h3 style="margin: 0">Time windows</h3>
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
              <input type="datetime-local" [ngModel]="local(w.from)" (ngModelChange)="setRange(drv, w, $event, null)" />
              to
              <input type="datetime-local" [ngModel]="local(w.to)" (ngModelChange)="setRange(drv, w, null, $event)" />
              <button class="btn sm danger" (click)="removeWindow(drv, w)">Remove</button>
            </div>
          } @empty {
            <p class="muted small">Available the whole race.</p>
          }
        </div>
      } @else {
        <div class="card">
          <h2>Which driver are you?</h2>
          <p class="muted small">Pick yourself to set your availability. This browser remembers it for this strategy.</p>
          <div class="row">
            @for (drv of d.drivers; track drv.id) {
              <button class="btn" (click)="store.setMe(drv.id)">
                <span class="dot" [style.background]="drv.color"></span> {{ drv.name }}
              </button>
            } @empty {
              <span class="muted">No driver in this strategy yet.</span>
            }
          </div>
        </div>
      }
    }
  `,
  styles: `
    .stints { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin-bottom: 12px; }
    .stint { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; text-align: left; padding: 8px 10px;
      border-radius: 6px; border: 1px solid var(--border); background: var(--panel-2); color: var(--text); font: inherit; cursor: pointer; }
    .stint.preferred { border-color: var(--ok); background: color-mix(in srgb, var(--ok) 18%, var(--panel-2)); }
    .stint.unavailable { border-color: var(--bad); background: color-mix(in srgb, var(--bad) 14%, var(--panel-2)); }
  `,
})
export class MyAvailabilityTab {
  protected readonly store = inject(StrategyStore);
  protected readonly draft = computed(() => this.store.current()?.draft ?? null);
  protected readonly plan = computed(() => this.store.current()?.plan ?? null);
  protected readonly me = computed(() => {
    // read current() so in-place availability edits re-render
    const d = this.store.current()?.draft;
    const id = this.store.myDriverId();
    return d?.drivers.find((x) => x.id === id) ?? null;
  });
  protected readonly label = LABEL;
  protected readonly local = toLocalInput;
  protected readonly duration = formatDuration;

  clock(sec: number, withDay = false): string {
    return clockAt(this.draft()!.race.startTime, sec, withDay);
  }

  status(drv: Driver, j: number): Availability {
    const [from, to] = stintRealRange(this.draft()!, this.plan()!, j);
    return availabilityFor(drv, from, to);
  }

  driveSec(drv: Driver): number {
    const d = this.draft()!;
    return this.plan()!.stints.reduce((a, s, j) => a + (d.assignments[j]?.driverId === drv.id ? s.driveSec : 0), 0);
  }

  cycle(drv: Driver, j: number, current: Availability): void {
    const [from, to] = stintRealRange(this.draft()!, this.plan()!, j);
    setAvailability(drv, from, to, NEXT[current]);
    this.store.availabilityChanged(drv);
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

  setRange(drv: Driver, w: AvailabilityWindow, fromText: string | null, toText: string | null): void {
    const from = fromText ? new Date(fromText).getTime() : w.from;
    const to = toText ? new Date(toText).getTime() : w.to;
    if (isNaN(from) || isNaN(to)) return;
    drv.availability = drv.availability.filter((x) => x !== w);
    setAvailability(drv, Math.min(from, to), Math.max(from, to), w.status);
    this.store.availabilityChanged(drv);
  }
}
