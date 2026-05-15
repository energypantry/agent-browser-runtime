export const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: { type: 'string', default: 'intentional smoke failure' },
  },
};

export async function extract({ params, attempt }) {
  throw Object.assign(new Error(`${params.reason}; attempt=${attempt}`), { code: 'INTENTIONAL_SMOKE_FAILURE' });
}
