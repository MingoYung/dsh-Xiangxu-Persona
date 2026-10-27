const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

/** Account operations have no conversation target and never enter message delivery. */
export async function executeQQAccountOperation({ service, coordinator, args }) {
  if (args.platform !== 'qq') fail('QQ_ACCOUNT_PLATFORM', '当前账号操作仅支持已接入的个人 QQ');
  if (args.target != null) fail('QQ_ACCOUNT_TARGET', '账号操作不使用聊天目标；请使用真实查询返回的账号与联系人引用');
  if (!service) fail('QQ_ACCOUNT_UNAVAILABLE', '个人 QQ 账号操作尚未就绪');
  const input = { ...args, memoryRoot: coordinator.memoryRoot };
  const action = args.action ?? 'inspect';
  if (action === 'inspect') return service.inspect(input);
  if (action === 'read') return service.read(input);
  if (action !== 'execute') fail('QQ_ACCOUNT_ACTION', '请选择 inspect、read 或 execute 账号操作');
  if (!args.requestId) fail('QQ_ACCOUNT_OPERATION_ID_REQUIRED', '提交账号操作需要真实工具调用编号');
  return service.execute(input, {
    operationId: args.requestId, memoryRoot: coordinator.memoryRoot,
    sourceSessionId: args.sessionId, signal: args.signal,
    sourceRefs: args.sourceOptions?.sourceRefs ?? [], sourceRecordIds: args.sourceOptions?.sourceRecordIds ?? [],
  });
}

/** Merge real runtime facts without treating method existence as supported capability. */
export function mergeQQAccountCapabilities(facts, native) {
  if (!native) return facts;
  const identityMatches = Boolean(facts.accountId && facts.accountId === native.accountId);
  const items = [...(facts.items ?? [])];
  for (const id of ['friend.query', 'friend.request']) {
    const capability = native.items?.find(item => item.id === id);
    const supported = identityMatches && capability?.supported === true;
    const driverAvailable = supported && native.connected === true && capability?.driverAvailable === true;
    const item = { id, supported, available: driverAvailable, driverAvailable,
      provider: 'xiangxu-native-account',
      reason: !identityMatches ? '原生账号操作与当前 QQ 账号不一致或尚未登录' : capability?.reason ?? (driverAvailable ? null : '原生账号操作尚未就绪'),
    };
    const index = items.findIndex(item => item.id === id);
    if (index < 0) items.push(item); else items[index] = item;
  }
  return { ...facts, items };
}
