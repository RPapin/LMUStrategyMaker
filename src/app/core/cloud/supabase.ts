import { Injectable, computed, signal } from '@angular/core';
import { createClient, Session, SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../../../environments/environment';

export interface Profile {
  id: string;
  display_name: string;
}

@Injectable({ providedIn: 'root' })
export class Supabase {
  /** Null when the app runs in local-only mode. */
  readonly client: SupabaseClient | null;
  readonly session = signal<Session | null>(null);
  readonly ready = signal(false);
  readonly profile = signal<Profile | null>(null);
  readonly user = computed(() => this.session()?.user ?? null);
  readonly configured: boolean;
  private readonly initial: Promise<void>;

  constructor() {
    this.configured = !!(environment.supabaseUrl && environment.supabaseAnonKey);
    this.client = this.configured
      ? createClient(environment.supabaseUrl, environment.supabaseAnonKey, {
          auth: {
            // navigator.locks can hang under zone.js; a single tab does not need cross-tab locking
            lock: async (_name, _timeout, fn) => fn(),
          },
        })
      : null;
    if (!this.client) {
      this.ready.set(true);
      this.initial = Promise.resolve();
      return;
    }
    this.initial = this.client.auth.getSession().then(({ data }) => {
      this.session.set(data.session);
      this.ready.set(true);
      this.loadProfile();
    });
    this.client.auth.onAuthStateChange((_event, session) => {
      const changed = session?.user.id !== this.session()?.user.id;
      this.session.set(session);
      if (changed) this.loadProfile();
    });
  }

  /** Resolves once the initial session is known. */
  whenReady(): Promise<void> {
    return this.initial;
  }

  db(): SupabaseClient {
    if (!this.client) throw new Error('Supabase is not configured.');
    return this.client;
  }

  async signInWithEmail(email: string, next: string): Promise<void> {
    const { error } = await this.db().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}${next}` },
    });
    if (error) throw error;
  }

  async signInWithDiscord(next: string): Promise<void> {
    const { error } = await this.db().auth.signInWithOAuth({
      provider: 'discord',
      options: { redirectTo: `${location.origin}${next}` },
    });
    if (error) throw error;
  }

  async signOut(): Promise<void> {
    await this.db().auth.signOut();
  }

  async updateDisplayName(name: string): Promise<void> {
    const id = this.user()?.id;
    if (!id) return;
    const { error } = await this.db().from('profiles').update({ display_name: name }).eq('id', id);
    if (error) throw error;
    this.profile.set({ id, display_name: name });
  }

  private async loadProfile(): Promise<void> {
    const id = this.user()?.id;
    if (!id || !this.client) {
      this.profile.set(null);
      return;
    }
    const { data } = await this.client.from('profiles').select('id, display_name').eq('id', id).maybeSingle();
    this.profile.set(data);
  }
}
