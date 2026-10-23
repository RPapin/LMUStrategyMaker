import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Supabase } from './supabase';

/** Team pages need a signed-in user; otherwise go to the login page and come back after. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const sb = inject(Supabase);
  const router = inject(Router);
  if (!sb.configured) return router.createUrlTree(['/']);
  await sb.whenReady();
  return sb.user() ? true : router.createUrlTree(['/login'], { queryParams: { next: state.url } });
};
