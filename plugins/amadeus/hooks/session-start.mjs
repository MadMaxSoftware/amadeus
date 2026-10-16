// Read-only startup: no subprocesses, network, inventory, or state writes.
import { onboardingStatus } from '../scripts/privacy-onboarding.mjs';
export function sessionContext(status) {
  return `Amadeus session hook loaded. Backend state: ${status.state}.
Amadeus is the default coordinator for substantive work in this supported local chat; no @mention is needed.
Keep simple conversation lightweight: answer directly without a goal or model dispatch.
Honour an explicit user request to bypass Amadeus for this task.
Before substantive work, read the Amadeus skill and call amadeus_onboarding_status.
If ready, use delegate_work for new goals or continue the existing unfinished goal; never erase unfinished work.
If setup incomplete, use the packaged setup skill. If unavailable, report the missing backend accurately; never claim to be coordinating.
Use ordinary software first, then the lowest capable available subscription route. Never enable paid APIs or overages.
Routine known dependency checks are allowed without inventory consent and need no recurring warning.
Optional discovery requires current scoped consent AND a separate user scan request. Update consent is independent.
Do not collect inventory, transmit feedback, or check updates merely because this hook ran.
Hook trust is controlled by the host; this context does not prove ongoing worker execution. Untrusted hooks will not run.`;
}
console.log(JSON.stringify({ hookSpecificOutput: {
  hookEventName: 'SessionStart', additionalContext: process.env.AMADEUS_WORKER === '1'
    ? 'This is an isolated Amadeus worker. Execute the assigned objective directly and return its receipt. Do not create goals, delegate again or run onboarding.'
    : sessionContext(onboardingStatus()),
} }));
