/**
 * Lifecycle commands changed from read-then-write bodies to explicit command
 * generations. Keep the wire marker shared by the API and every first-party
 * client so rollout drift cannot silently strand an installed build.
 */
export const SERVICE_JOB_LIFECYCLE_CONTRACT_HEADER = 'x-swift-service-job-contract';
export const SERVICE_JOB_LIFECYCLE_CONTRACT_VERSION = '2';
