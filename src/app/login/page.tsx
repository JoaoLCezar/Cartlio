import { AuthPage } from "@/components/auth-page";
import { safeInvitationReturnPath } from "@/lib/auth-redirect";
export const dynamic = "force-dynamic";
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const search = await searchParams;
  const next = Array.isArray(search.next) ? search.next[0] : search.next;
  return <AuthPage next={safeInvitationReturnPath(next) ?? undefined} />;
}
