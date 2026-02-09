type JsonSchema = Record<string, unknown>;

export class SchemaOptimizer {
  static createOptimizedJsonSchema(
    schema: JsonSchema,
    options: {
      removeMinItems?: boolean;
      removeDefaults?: boolean;
    } = {}
  ): JsonSchema {
    const defsLookup = (schema.$defs as Record<string, JsonSchema>) ?? {};
    const removeMinItems = options.removeMinItems ?? false;
    const removeDefaults = options.removeDefaults ?? false;

    const optimize = (obj: any, inProperties = false): any => {
      if (Array.isArray(obj)) {
        return obj.map((item) => optimize(item, inProperties));
      }

      if (obj && typeof obj === 'object') {
        let flattenedRef: any = null;
        const optimized: Record<string, any> = {};

        for (const [key, value] of Object.entries(obj)) {
          if (key === '$defs' || key === 'additionalProperties') continue;
          if (key === 'title' && !inProperties) continue;
          if (
            removeMinItems &&
            (key === 'minItems' || key === 'min_items')
          ) {
            continue;
          }
          if (removeDefaults && key === 'default') continue;

          if (key === '$ref' && typeof value === 'string') {
            const refName = value.split('/').pop()!;
            if (defsLookup[refName]) {
              flattenedRef = optimize(defsLookup[refName], inProperties);
            }
            continue;
          }

          if (key === 'properties') {
            optimized[key] = optimize(value, true);
            continue;
          }

          if (typeof value === 'object' && value !== null) {
            optimized[key] = optimize(value, inProperties);
            continue;
          }

          optimized[key] = value;
        }

        const result = flattenedRef
          ? { ...flattenedRef, ...optimized }
          : optimized;
        if (
          result.type === 'object' &&
          result.additionalProperties === undefined
        ) {
          result.additionalProperties = false;
        }
        return result;
      }

      return obj;
    };

    const optimizedSchema = optimize(schema);

    const ensureAdditionalProperties = (obj: any) => {
      if (Array.isArray(obj)) {
        obj.forEach(ensureAdditionalProperties);
        return;
      }
      if (obj && typeof obj === 'object') {
        if (obj.type === 'object' && obj.additionalProperties === undefined) {
          obj.additionalProperties = false;
        }
        Object.values(obj).forEach(ensureAdditionalProperties);
      }
    };

    ensureAdditionalProperties(optimizedSchema);
    SchemaOptimizer.makeStrictCompatible(optimizedSchema);
    return optimizedSchema;
  }

  static makeStrictCompatible(schema: any) {
    if (Array.isArray(schema)) {
      schema.forEach(SchemaOptimizer.makeStrictCompatible);
      return;
    }
    if (schema && typeof schema === 'object') {
      for (const [key, value] of Object.entries(schema)) {
        if (key !== 'required' && value && typeof value === 'object') {
          SchemaOptimizer.makeStrictCompatible(value);
        }
      }
      if (schema.type === 'object' && schema.properties) {
        schema.required = Object.keys(schema.properties);
      }
    }
  }
}
