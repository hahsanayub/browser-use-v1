/**
 * Utilities for creating optimized schemas for LLM usage.
 */

export class SchemaOptimizer {
  /**
   * Create the most optimized schema by flattening all $ref/$defs while preserving
   * FULL descriptions and ALL action definitions. Also ensures compatibility with different LLM providers.
   *
   * @param schema - The original JSON schema to optimize
   * @returns Optimized schema with all $refs resolved and compatibility ensured
   */
  static createOptimizedJsonSchema(
    schema: Record<string, any>
  ): Record<string, any> {
    // For now, we'll assume the schema is already in a good format
    // This can be extended to handle more complex transformations if needed

    // Extract $defs for reference resolution, then flatten everything
    const defsLookup = schema.$defs || {};

    const optimizeSchema = (
      obj: any,
      defs?: Record<string, any>,
      inProperties = false
    ): any => {
      if (typeof obj === 'object' && obj !== null) {
        if (Array.isArray(obj)) {
          return obj.map((item) => optimizeSchema(item, defs, inProperties));
        }

        const optimized: any = {};
        let flattenedRef: any = null;

        // Skip unnecessary fields AND $defs (we'll inline everything)
        const skipFields = ['additionalProperties', '$defs'];

        for (const [key, value] of Object.entries(obj)) {
          if (skipFields.includes(key)) {
            continue;
          }

          // Skip metadata "title" unless we're iterating inside an actual `properties` map
          if (key === 'title' && !inProperties) {
            continue;
          }

          // Preserve FULL descriptions without truncation
          if (key === 'description') {
            optimized[key] = value;
          }

          // Handle type field
          else if (key === 'type') {
            optimized[key] = value;
          }

          // FLATTEN: Resolve $ref by inlining the actual definition
          else if (key === '$ref' && defs) {
            const refPath = (value as string).split('/').pop(); // Get the definition name from "#/$defs/SomeName"
            if (refPath && defs[refPath]) {
              // Get the referenced definition and flatten it
              const referencedDef = defs[refPath];
              flattenedRef = optimizeSchema(referencedDef, defs);
            }
          }

          // Keep all anyOf structures (action unions) and resolve any $refs within
          else if (key === 'anyOf' && Array.isArray(value)) {
            optimized[key] = value.map((item) => optimizeSchema(item, defs));
          }

          // Recursively optimize nested structures
          else if (['properties', 'items'].includes(key)) {
            optimized[key] = optimizeSchema(value, defs, key === 'properties');
          }

          // Keep essential validation fields
          else if (
            [
              'type',
              'required',
              'minimum',
              'maximum',
              'minItems',
              'maxItems',
              'pattern',
              'default',
            ].includes(key)
          ) {
            optimized[key] =
              typeof value === 'object' ? optimizeSchema(value, defs) : value;
          }

          // Skip unsupported fields for LLM APIs (especially Google Gemini)
          else if (
            ['exclusiveMinimum', 'exclusiveMaximum', '$schema'].includes(key)
          ) {
            // Skip these fields as they're not supported by Google Gemini API
            continue;
          }

          // Recursively process all other fields
          else {
            optimized[key] =
              typeof value === 'object' ? optimizeSchema(value, defs) : value;
          }
        }

        // If we have a flattened reference, merge it with the optimized properties
        if (flattenedRef && typeof flattenedRef === 'object') {
          // Start with the flattened reference as the base
          const result = { ...flattenedRef };

          // Merge in any sibling properties that were processed
          for (const [key, value] of Object.entries(optimized)) {
            // Preserve descriptions from the original object if they exist
            if (key === 'description' && !('description' in result)) {
              result[key] = value;
            } else if (key !== 'description') {
              // Don't overwrite description from flattened ref
              result[key] = value;
            }
          }

          return result;
        } else {
          // No $ref, just return the optimized object
          // Add additionalProperties: false to ALL objects for strict mode compatibility
          if (optimized.type === 'object') {
            optimized.additionalProperties = false;
          }

          return optimized;
        }
      }

      return obj;
    };

    // Create optimized schema with flattening
    const optimizedResult = optimizeSchema(schema, defsLookup);

    // Ensure we have a dictionary (should always be the case for schema root)
    if (typeof optimizedResult !== 'object' || optimizedResult === null) {
      throw new Error('Optimized schema result is not a valid object');
    }

    const optimizedSchema = optimizedResult;

    // Additional pass to ensure ALL objects have additionalProperties: false
    const ensureAdditionalPropertiesFalse = (obj: any): void => {
      if (typeof obj === 'object' && obj !== null) {
        if (Array.isArray(obj)) {
          obj.forEach(ensureAdditionalPropertiesFalse);
        } else {
          // If it's an object type, ensure additionalProperties is false
          if (obj.type === 'object') {
            obj.additionalProperties = false;
          }

          // Recursively apply to all values
          Object.values(obj).forEach((value) => {
            if (typeof value === 'object' && value !== null) {
              ensureAdditionalPropertiesFalse(value);
            }
          });
        }
      }
    };

    ensureAdditionalPropertiesFalse(optimizedSchema);
    this.makeStrictCompatible(optimizedSchema);

    return optimizedSchema;
  }

  /**
   * Ensure all properties are required for strict mode compatibility
   */
  private static makeStrictCompatible(schema: any): void {
    if (typeof schema === 'object' && schema !== null) {
      if (Array.isArray(schema)) {
        schema.forEach((item) => this.makeStrictCompatible(item));
      } else {
        // First recursively apply to nested objects
        Object.entries(schema).forEach(([key, value]) => {
          if (
            typeof value === 'object' &&
            value !== null &&
            key !== 'required'
          ) {
            this.makeStrictCompatible(value);
          }
        });

        // Then update required for this level
        if (schema.properties && schema.type === 'object') {
          // Add all properties to required array
          const allProps = Object.keys(schema.properties);
          schema.required = allProps; // Set all properties as required
        }
      }
    }
  }
}
