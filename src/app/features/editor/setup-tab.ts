import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CATEGORIES, tyresForCategory } from '../../core/defaults';
import { StrategyStore } from '../../core/strategy-store';
import { Category, TyreCompound } from '../../core/models';
import { clockAt, formatDuration, uid } from '../../core/util';
import { LapInput } from '../../shared/lap-input';

@Component({
  selector: 'app-setup-tab',
  imports: [FormsModule, LapInput],
  template: `
    @if (draft(); as d) {
      <div (input)="store.touch()" (change)="store.touch()">
        <div class="card">
          <h3>Race</h3>
          <div class="grid">
            <label class="field">Category
              <select [ngModel]="d.race.category" (ngModelChange)="setCategory($event)">
                @for (c of categories; track c.id) {
                  <option [ngValue]="c.id">{{ c.name }}</option>
                }
              </select>
            </label>
            <label class="field">Race type
              <select [(ngModel)]="d.race.mode">
                <option value="time">Timed race</option>
                <option value="laps">Fixed laps</option>
              </select>
            </label>
            @if (d.race.mode === 'time') {
              <label class="field">Duration (minutes)
                <input type="number" min="1" [(ngModel)]="d.race.durationMin" />
                <span class="small">{{ fmt(d.race.durationMin * 60) }}</span>
              </label>
            } @else {
              <label class="field">Race length (laps)
                <input type="number" min="1" [(ngModel)]="d.race.laps" />
              </label>
            }
            <label class="field">Race start (local time)
              <input type="datetime-local" [(ngModel)]="d.race.startTime" />
            </label>
          </div>
        </div>

        <div class="card">
          <h3>Car &amp; pace</h3>
          <div class="grid">
            <label class="field">Avg lap time – dry <app-lap-input [(ngModel)]="d.car.lapTimeDrySec" /></label>
            <label class="field">Avg lap time – wet <app-lap-input [(ngModel)]="d.car.lapTimeWetSec" /></label>
            <label class="field">{{ energy(d.race.category) }} per lap – dry (%)
              <input type="number" step="0.01" min="0" [(ngModel)]="d.car.vePerLapDry" />
              <span class="small">≈ {{ lapsPerTank(d.car.vePerLapDry) }} laps per tank</span>
            </label>
            <label class="field">{{ energy(d.race.category) }} per lap – wet (%)
              <input type="number" step="0.01" min="0" [(ngModel)]="d.car.vePerLapWet" />
              <span class="small">≈ {{ lapsPerTank(d.car.vePerLapWet) }} laps per tank</span>
            </label>
            <label class="field">{{ energy(d.race.category) }} at start (%)
              <input type="number" min="0" max="100" [(ngModel)]="d.race.startVePct" />
            </label>
            <label class="field">{{ energy(d.race.category) }} safety margin (%)
              <input type="number" step="0.1" min="0" [(ngModel)]="d.race.veMarginPct" />
            </label>
          </div>
        </div>

        <div class="card">
          <h3>Pit stop</h3>
          <div class="grid">
            <label class="field">Pit lane time loss (s)
              <input type="number" step="0.1" min="0" [(ngModel)]="d.race.pitLaneLossSec" />
            </label>
            <label class="field">Refuel time per 1% {{ energy(d.race.category) }} (s)
              <input type="number" step="0.01" min="0" [(ngModel)]="d.race.refuelSecPerPct" />
              <span class="small">Full refuel ≈ {{ (d.race.refuelSecPerPct * 100).toFixed(1) }} s</span>
            </label>
            <label class="field">Tyre change, 4 tyres (s)
              <input type="number" step="0.1" min="0" [(ngModel)]="d.race.tyreChange4Sec" />
            </label>
            <label class="field">Tyre change, 2 tyres – one side (s)
              <input type="number" step="0.1" min="0" [(ngModel)]="d.race.tyreChange2Sec" />
            </label>
            <label class="field">Driver change (s)
              <input type="number" step="0.1" min="0" [(ngModel)]="d.race.driverChangeSec" />
            </label>
            <label class="field">Service
              <select [(ngModel)]="d.race.serviceParallel">
                <option [ngValue]="true">Refuel, tyres &amp; driver at the same time</option>
                <option [ngValue]="false">One after the other</option>
              </select>
            </label>
          </div>
        </div>

        <div class="card">
          <div class="row" style="margin-bottom: 12px">
            <h3 style="margin: 0">Tyres</h3>
            <span class="muted small">Compounds allowed for {{ categoryName(d.race.category) }}.</span>
          </div>
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>Compound</th><th>Weather</th><th>Tyres available</th><th>Wear / lap (%)</th>
                  <th>Life</th><th>Time lost / lap of age (s)</th><th>Pace vs base (s)</th>
                </tr>
              </thead>
              <tbody>
                @for (t of d.tyres; track t.id) {
                  <tr>
                    <td><b>{{ t.name }}</b></td>
                    <td>
                      <span class="chip" [class.wet]="t.weather === 'wet'">{{ t.weather === 'wet' ? 'Wet' : 'Dry' }}</span>
                    </td>
                    <td>
                      <input type="number" min="0" step="2" [(ngModel)]="t.tyres" style="width: 70px" />
                      <span class="muted small"> = {{ t.tyres / 4 }} sets</span>
                    </td>
                    <td><input type="number" step="0.1" min="0" [(ngModel)]="t.wearPctPerLap" style="width: 80px" /></td>
                    <td class="muted num">{{ life(t) }} laps</td>
                    <td><input type="number" step="0.005" min="0" [(ngModel)]="t.degSecPerLap" style="width: 90px" /></td>
                    <td><input type="number" step="0.05" [(ngModel)]="t.paceOffsetSec" style="width: 80px" /></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="grid" style="margin-top: 12px">
            <label class="field">Penalty beyond tyre life (s per lap over)
              <input type="number" step="0.1" min="0" [(ngModel)]="d.race.cliffPenaltySec" />
            </label>
            <label class="field">Penalty on wrong tyre for weather (s / lap)
              <input type="number" step="0.5" min="0" [(ngModel)]="d.race.mismatchPenaltySec" />
            </label>
          </div>
        </div>

        <div class="card">
          <div class="row" style="margin-bottom: 12px">
            <h3 style="margin: 0">Weather forecast</h3>
            <span class="muted small">Dry unless a window says otherwise. Times are minutes from the start.</span>
            <span class="spacer"></span>
            <button class="btn sm" (click)="addWeather()">+ Add window</button>
          </div>
          @for (w of d.race.weather; track w.id) {
            <div class="row" style="margin-bottom: 8px">
              <select [(ngModel)]="w.weather">
                <option value="wet">Wet</option>
                <option value="dry">Dry</option>
              </select>
              from <input type="number" min="0" [(ngModel)]="w.fromMin" style="width: 80px" /> min
              <span class="muted small">({{ clock(w.fromMin) }})</span>
              to <input type="number" min="0" [(ngModel)]="w.toMin" style="width: 80px" /> min
              <span class="muted small">({{ clock(w.toMin) }})</span>
              <button class="btn sm danger" (click)="removeWeather(w.id)">Remove</button>
            </div>
          } @empty {
            <p class="muted small" style="margin: 0">No wet window: full dry race.</p>
          }
        </div>
      </div>
    }
  `,
})
export class SetupTab {
  protected readonly store = inject(StrategyStore);
  protected readonly draft = computed(() => this.store.current()?.draft ?? null);
  protected readonly fmt = formatDuration;
  protected readonly categories = CATEGORIES;

  lapsPerTank(ve: number): number {
    const d = this.draft()!;
    return ve > 0 ? Math.floor((100 - d.race.veMarginPct) / ve) : 0;
  }

  life(t: TyreCompound): string {
    return t.wearPctPerLap > 0 ? String(Math.floor(100 / t.wearPctPerLap)) : '∞';
  }

  clock(min: number): string {
    return clockAt(this.draft()!.race.startTime, min * 60);
  }

  setCategory(category: Category): void {
    const d = this.draft()!;
    d.race.category = category;
    d.tyres = tyresForCategory(category, d.tyres);
    // compound overrides may point at a compound that no longer exists
    for (const o of d.overrides) if (o?.compoundId && !d.tyres.some((t) => t.id === o.compoundId)) o.compoundId = null;
    this.store.touch();
  }

  /** LMP2 runs on fuel, Hypercar and LMGT3 on virtual energy. Both are entered as % of the tank. */
  energy(category: Category): string {
    return category === 'lmp2' ? 'Fuel' : 'VE';
  }

  categoryName(category: Category): string {
    return CATEGORIES.find((c) => c.id === category)?.name ?? category;
  }

  addWeather(): void {
    const d = this.draft()!;
    d.race.weather.push({ id: uid(), fromMin: 60, toMin: 120, weather: 'wet' });
    this.store.touch();
  }

  removeWeather(id: string): void {
    const d = this.draft()!;
    d.race.weather = d.race.weather.filter((w) => w.id !== id);
    this.store.touch();
  }
}
