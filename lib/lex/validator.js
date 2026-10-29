/**
 * XRPC Standard Error class
 */
export class XRPCError extends Error {
  /**
   * @param {number} status
   * @param {string} error - Standard AT-Proto error string (e.g. InvalidRequest)
   * @param {string} [message]
   */
  constructor(status, error, message) {
    super(message || error);
    this.name = 'XRPCError';
    this.status = status;
    this.error = error;
    this.message = message || error;
  }

  toJSON() {
    return {
      error: this.error,
      message: this.message,
    };
  }

  static invalidRequest(message) {
    return new XRPCError(400, 'InvalidRequest', message);
  }

  static authRequired(message = 'Authentication required.') {
    return new XRPCError(401, 'AuthenticationRequired', message);
  }

  static forbidden(message = 'Forbidden.') {
    return new XRPCError(403, 'Forbidden', message);
  }

  static notFound(message = 'Record or resource not found.') {
    return new XRPCError(404, 'NotFound', message);
  }

  static methodNotImplemented(method) {
    return new XRPCError(501, 'MethodNotImplemented', `Method ${method} is not implemented.`);
  }
}

/**
 * Validates a value against a Lexicon property schema definition
 * @param {any} val - Value to check
 * @param {object} propSchema - Lexicon property schema
 * @param {string} path - Breadcrumb string for error reporting
 */
export function validateProperty(val, propSchema, path) {
  if (val === undefined || val === null) {
    return; // nullability / required handled at object level
  }

  const expectedType = propSchema.type;

  switch (expectedType) {
    case 'string': {
      if (typeof val !== 'string') {
        throw XRPCError.invalidRequest(`${path} must be a string.`);
      }
      if (typeof propSchema.maxLength === 'number' && val.length > propSchema.maxLength) {
        throw XRPCError.invalidRequest(`${path} exceeds maximum length of ${propSchema.maxLength} characters.`);
      }
      if (typeof propSchema.minLength === 'number' && val.length < propSchema.minLength) {
        throw XRPCError.invalidRequest(`${path} must be at least ${propSchema.minLength} characters.`);
      }
      if (Array.isArray(propSchema.knownValues) && !propSchema.knownValues.includes(val)) {
        // knownValues is an advisory enum in AT-Proto, but we can enforce if strict
      }
      break;
    }
    case 'integer':
    case 'number': {
      if (typeof val !== 'number' || (expectedType === 'integer' && !Number.isInteger(val))) {
        throw XRPCError.invalidRequest(`${path} must be an ${expectedType}.`);
      }
      if (typeof propSchema.minimum === 'number' && val < propSchema.minimum) {
        throw XRPCError.invalidRequest(`${path} must be >= ${propSchema.minimum}.`);
      }
      if (typeof propSchema.maximum === 'number' && val > propSchema.maximum) {
        throw XRPCError.invalidRequest(`${path} must be <= ${propSchema.maximum}.`);
      }
      break;
    }
    case 'boolean': {
      if (typeof val !== 'boolean') {
        throw XRPCError.invalidRequest(`${path} must be a boolean.`);
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(val)) {
        throw XRPCError.invalidRequest(`${path} must be an array.`);
      }
      if (typeof propSchema.maxLength === 'number' && val.length > propSchema.maxLength) {
        throw XRPCError.invalidRequest(`${path} contains more than ${propSchema.maxLength} items.`);
      }
      if (propSchema.items) {
        for (let i = 0; i < val.length; i++) {
          validateProperty(val[i], propSchema.items, `${path}[${i}]`);
        }
      }
      break;
    }
    case 'object': {
      if (typeof val !== 'object' || Array.isArray(val)) {
        throw XRPCError.invalidRequest(`${path} must be an object.`);
      }
      validateObject(val, propSchema, path);
      break;
    }
    case 'unknown':
    case 'union':
    case 'ref':
      // Open / dynamic payload reference
      break;
    default:
      break;
  }
}

/**
 * Validates an object record against an object schema
 * @param {object} obj - Object payload
 * @param {object} schema - Schema definition with required and properties
 * @param {string} [path='record']
 */
export function validateObject(obj, schema, path = 'record') {
  if (typeof obj !== 'object' || obj === null) {
    throw XRPCError.invalidRequest(`${path} must be an object.`);
  }

  // Check required properties
  if (Array.isArray(schema.required)) {
    for (const reqKey of schema.required) {
      if (obj[reqKey] === undefined || obj[reqKey] === null) {
        throw XRPCError.invalidRequest(`${path}.${reqKey} is required.`);
      }
    }
  }

  // Check defined properties
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (obj[key] !== undefined) {
        validateProperty(obj[key], propSchema, `${path}.${key}`);
      }
    }
  }
}
