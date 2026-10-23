import { Component, forwardRef, signal } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';
import { formatLap, parseLap } from '../core/util';

/** Text input for lap times ("2:05.432"), bound as a number of seconds. */
@Component({
  selector: 'app-lap-input',
  template: `<input
    [value]="text()"
    [class.invalid]="invalid()"
    placeholder="m:ss.000"
    (input)="onInput($any($event.target).value)"
    (blur)="onBlur()"
  />`,
  styles: `input { width: 100%; }`,
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => LapInput), multi: true }],
})
export class LapInput implements ControlValueAccessor {
  protected readonly text = signal('');
  protected readonly invalid = signal(false);
  private value = 0;
  private onChange: (v: number) => void = () => {};
  private onTouched: () => void = () => {};

  writeValue(v: number): void {
    this.value = v ?? 0;
    this.text.set(formatLap(this.value));
    this.invalid.set(false);
  }

  registerOnChange(fn: (v: number) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  protected onInput(raw: string): void {
    this.text.set(raw);
    const v = parseLap(raw);
    this.invalid.set(!(v > 0));
    if (v > 0) {
      this.value = v;
      this.onChange(v);
    }
  }

  protected onBlur(): void {
    this.text.set(formatLap(this.value));
    this.invalid.set(false);
    this.onTouched();
  }
}
