/*
 * Customer self-serve registration no longer exists (shopping and
 * checkout are guest-only). `/login` remains for ADMIN / AFFILIATE
 * dashboard sign-in only — hence no REGISTER entry.
 */
export const AUTH_ROUTES = {
  LOGIN: "/login",

  PRODUCTS: "/products",

  DASHBOARD: "/dashboard",

  ADMIN: "/admin",

  SELLER: "/seller/dashboard",
};