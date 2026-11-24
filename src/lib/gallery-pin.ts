import "server-only";
import { cookies } from "next/headers";

export const galleryPinCookieName = (token: string) => `cartlio_pin_${token}`;

export async function galleryPinSession(token: string) {
  return (await cookies()).get(galleryPinCookieName(token))?.value ?? null;
}
