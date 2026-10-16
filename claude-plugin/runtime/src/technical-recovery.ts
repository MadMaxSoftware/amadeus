/** Additional model work must not override an explicit one-shot or retry boundary. */
export function hasExplicitAttemptRestriction(constraints: string): boolean {
  return /\b(?:no|zero|without)\s+(?:automatic\s+)?retr(?:y|ies)\b|\b(?:do not|never)\s+(?:retry|repeat|rerun)\b|\bone-time\b|\b(?:run|execute|invoke|attempt|call)(?:\s+\w+){0,3}\s+once\b|\b(?:one|single|1)\s+(?:more\s+|additional\s+)?(?:isolated\s+|participant\s+|model\s+)?(?:attempt|call|run|invocation)\b|\b(?:exactly|at most|maximum|up to|only)\s+\w+\s+(?:model\s+)?(?:attempts?|calls?|runs?|invocations?)\b|\b(?:ask|stop|obtain|seek|require)\b[^.\n;]*\b(?:approval|permission|before)\b[^.\n;]*(?:retry|another|additional|replacement)/i.test(constraints);
}
