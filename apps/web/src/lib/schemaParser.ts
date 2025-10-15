import { GTS_REGEX, GTS_TYPE_REGEX, GTS_OBJ_REGEX } from '@gts/shared'

export interface PropertyInfo {
  name: string
  type: string
  value?: any
  required?: boolean
  description?: string
  children?: PropertyInfo[]
  isGtsType?: boolean
  isGtsObj?: boolean
}

export function parseJsonToProperties(data: any, name = 'root'): PropertyInfo[] {
  if (data === null || data === undefined) {
    return [{
      name,
      type: data === null ? 'null' : 'undefined',
      value: data
    }]
  }

  if (typeof data !== 'object') {
    return [{
      name,
      type: typeof data,
      value: data
    }]
  }

  if (Array.isArray(data)) {
    const children: PropertyInfo[] = data.map((item, index) => {
      if (typeof item === 'object' && item !== null) {
        return {
          name: `[${index}]`,
          type: Array.isArray(item) ? 'array' : 'object',
          children: parseJsonToProperties(item, `[${index}]`)
        }
      } else {
        return {
          name: `[${index}]`,
          type: getJsonType(item),
          value: item
        }
      }
    })

    if (name === 'root') {
      return children
    }
    return [{
      name,
      type: 'array',
      children
    }]
  }

  // Object - directly return the properties without creating a wrapper
  const children: PropertyInfo[] = Object.entries(data).map(([key, value]) => {
    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        return {
          name: key,
          type: 'array',
          children: value.map((item, index) => {
            if (typeof item === 'object' && item !== null) {
              return {
                name: `[${index}]`,
                type: Array.isArray(item) ? 'array' : 'object',
                children: parseJsonToProperties(item, `[${index}]`)
              }
            } else {
              return {
                name: `[${index}]`,
                type: getJsonType(item),
                value: item
              }
            }
          })
        }
      } else {
        // For nested objects, use recursive parsing
        return {
          name: key,
          type: 'object',
          children: parseJsonToProperties(value, key)
        }
      }
    } else {
      return {
        name: key,
        type: getJsonType(value),
        value: value
      }
    }
  })

  return children
}

export function parseSchemaToProperties(schema: any): PropertyInfo[] {
  if (!schema || typeof schema !== 'object') {
    return []
  }

  const properties: PropertyInfo[] = []

  // Show extension annotations (x-*) as regular fields
  Object.entries(schema)
    .filter(([key]) => key.startsWith('x-'))
    .forEach(([key, value]) => {
      const childProps = typeof value === 'object' && value !== null
        ? parseJsonToProperties(value, key)
        : [{ name: 'value', type: typeof value, value}]

      properties.push({
        name: key,
        type: Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value,
        children: childProps
      })
    })

  // Handle schema properties
  if (schema.properties) {
    const required = schema.required || []

    Object.entries(schema.properties).forEach(([key, prop]: [string, any]) => {
      let description = prop.description
      let isGtsType = false
      let isGtsObj = false

      // Add $ref information to description
      if (prop.$ref) {
        const refDescription = `Ref: ${prop.$ref}`
        description = description ? `${description}\n${refDescription}` : refDescription
        if (GTS_TYPE_REGEX.test(prop.$ref)) isGtsType = true
        if (GTS_REGEX.test(prop.$ref)) isGtsObj = true
      }

      // Add pattern information
      if (prop.pattern) {
        const patDescription = `Pattern: ${prop.pattern}`
        description = description ? `${description}\n${patDescription}` : patDescription
      }

      if (prop['x-gts-type']) {
        const gtsTypeDescription = `GTS Type: ${prop['x-gts-type']}`
        description = description ? `${description}\n${gtsTypeDescription}` : gtsTypeDescription
        isGtsType = true
      }

      properties.push({
        name: key,
        type: getSchemaType(prop),
        required: required.includes(key),
        description,
        children: getSchemaChildren(prop),
        isGtsType,
        isGtsObj
      })
    })
  }

  // Handle allOf, oneOf, anyOf
  if (schema.allOf) {
    schema.allOf.forEach((subSchema: any, index: number) => {

      const subProperties = parseSchemaToProperties(subSchema)
      let description = subSchema.description
      let isGtsType = false
      let isGtsObj = false

      // Add schema title or $ref information
      if (subSchema.title) {
        const titleDescription = `Schema: ${subSchema.title}`
        description = description ? `${description}\n${titleDescription}` : titleDescription
        if (GTS_TYPE_REGEX.test(subSchema.$ref)) isGtsType = true
      }

      if (subSchema.$ref) {
        const refDescription = `Ref: ${subSchema.$ref}`
        description = description ? `${description}\n${refDescription}` : refDescription
        if (GTS_TYPE_REGEX.test(subSchema.$ref)) isGtsType = true
        if (GTS_OBJ_REGEX.test(subSchema.$ref)) isGtsObj = true
      }

      properties.push({
        name: `allOf[${index}]`,
        type: 'schema',
        description,
        children: subProperties,
        isGtsType,
        isGtsObj
      })
    })
  }

  if (schema.oneOf) {
    schema.oneOf.forEach((subSchema: any, index: number) => {
      const subProperties = parseSchemaToProperties(subSchema)
      let description = subSchema.description

      // Add schema title or $ref information
      if (subSchema.title) {
        const titleDescription = `Schema: ${subSchema.title}`
        description = description ? `${description}\n${titleDescription}` : titleDescription
      }
      if (subSchema.$ref) {
        const refDescription = `Ref: ${subSchema.$ref}`
        description = description ? `${description}\n${refDescription}` : refDescription
      }

      properties.push({
        name: `oneOf[${index}]`,
        type: 'schema',
        description,
        children: subProperties
      })
    })
  }

  if (schema.anyOf) {
    schema.anyOf.forEach((subSchema: any, index: number) => {
      const subProperties = parseSchemaToProperties(subSchema)
      let description = subSchema.description

      // Add schema title or $ref information
      if (subSchema.title) {
        const titleDescription = `Schema: ${subSchema.title}`
        description = description ? `${description}\n${titleDescription}` : titleDescription
      }
      if (subSchema.$ref) {
        const refDescription = `Ref: ${subSchema.$ref}`
        description = description ? `${description}\n${refDescription}` : refDescription
      }

      properties.push({
        name: `anyOf[${index}]`,
        type: 'schema',
        description,
        children: subProperties
      })
    })
  }

  // Handle array items
  if (schema.type === 'array' && schema.items) {
    const itemProperties = parseSchemaToProperties(schema.items)
    if (itemProperties.length > 0) {
      properties.push({
        name: 'items',
        type: 'schema',
        children: itemProperties
      })
    }
  }

  return properties
}

function getJsonType(value: any): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function getSchemaType(schema: any): string {
  if (schema.$ref) {
    return '$ref'
  }

  if (schema.type) {
    if (Array.isArray(schema.type)) {
      return schema.type.join(' | ')
    }
    return schema.type
  }

  if (schema.enum) {
    return 'enum'
  }

  if (schema.const !== undefined) {
    return 'const'
  }

  if (schema.allOf) return 'allOf'
  if (schema.oneOf) return 'oneOf'
  if (schema.anyOf) return 'anyOf'

  return 'unknown'
}

function getSchemaChildren(schema: any): PropertyInfo[] | undefined {
  // Handle $ref - don't expand children for references, let the description show the reference
  if (schema.$ref) {
    return undefined
  }

  if (schema.type === 'object' && schema.properties) {
    return parseSchemaToProperties(schema)
  }

  if (schema.type === 'array' && schema.items) {
    return parseSchemaToProperties(schema.items)
  }

  if (schema.enum) {
    return schema.enum.map((value: any, index: number) => ({
      name: `[${index}]`,
      type: typeof value,
      value
    }))
  }

  if (schema.const !== undefined) {
    return [{
      name: 'value',
      type: typeof schema.const,
      value: schema.const
    }]
  }

  // Handle allOf, oneOf, anyOf in children
  if (schema.allOf || schema.oneOf || schema.anyOf) {
    return parseSchemaToProperties(schema)
  }

  return undefined
}
