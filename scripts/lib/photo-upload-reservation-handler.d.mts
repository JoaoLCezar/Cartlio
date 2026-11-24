export function handlePhotoUploadReservation(
  request: Request,
  dependencies: {
    userClient: unknown;
    env?: NodeJS.ProcessEnv;
    isTrustedOrigin?: boolean;
  },
): Promise<Response>;
