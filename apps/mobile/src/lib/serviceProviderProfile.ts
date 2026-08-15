/** Missing provider profile is an expected onboarding state. Only a definitive
 * 404 becomes null; authorization, transport, and server failures must stay
 * visible instead of masquerading as permission to create another identity. */
export async function unwrapOptionalServiceProviderProfile<T>(request: Promise<any>): Promise<T | null> {
  try {
    const response = await request;
    return response?.data?.data as T;
  } catch (error: any) {
    if (error?.response?.status === 404) return null;
    throw error;
  }
}
