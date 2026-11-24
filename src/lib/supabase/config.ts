export function supabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  return url && key ? { url, key, storageUrl: process.env.NEXT_PUBLIC_SUPABASE_STORAGE_URL || url } : null;
}
