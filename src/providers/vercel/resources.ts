const MAX_SANDBOX_VCPUS = 32;

/**
 * Vercel provisions 1 vCPU or an even count up to the plan cap of 32; memory
 * is fixed at 2048 MB per vCPU. Enforced identically for CLI requests, SDK
 * create calls, and persisted metadata so one rule owns the domain.
 */
export function assertSandboxVcpus(vcpus: number): void {
  if (
    !Number.isFinite(vcpus) ||
    !Number.isInteger(vcpus) ||
    vcpus <= 0 ||
    vcpus > MAX_SANDBOX_VCPUS ||
    (vcpus !== 1 && vcpus % 2 !== 0)
  ) {
    throw new Error('Vercel Sandbox vcpus must be 1 or an even integer up to 32');
  }
}
