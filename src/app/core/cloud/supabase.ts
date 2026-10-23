import { Injectable } from '@angular/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../../../environments/environment';

/** Supabase client without login: shared strategies are reached with their secret link token. */
@Injectable({ providedIn: 'root' })
export class Supabase {
  /** Null when the app runs in local-only mode. */
  readonly client: SupabaseClient | null;
  readonly configured = !!(environment.supabaseUrl && environment.supabaseAnonKey);

  constructor() {
    this.client = this.configured
      ? createClient(environment.supabaseUrl, environment.supabaseAnonKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        })
      : null;
  }

  db(): SupabaseClient {
    if (!this.client) throw new Error('Sharing is not configured (src/environments/environment.ts).');
    return this.client;
  }
}
