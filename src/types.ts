export type SessionUser = { id: string; username: string; avatar: string | null; accessToken: string };

declare global {
  namespace CookieSessionInterfaces {
    interface CookieSessionObject {
      user?: SessionUser;
      oauthState?: string;
    }
  }
}
