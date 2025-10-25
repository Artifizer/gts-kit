import * as vscode from 'vscode'
import * as path from 'path'
import { JsonRegistry, ValidationError, DEFAULT_GTS_CONFIG, parseJSONC } from '@gts/shared'
import { getLastScanFiles } from './scanStore'
import { isGtsCandidateFile } from './helpers'

// Debug flag for validation logging - set to true to enable detailed logs
let DEBUG_VALIDATION = false

let diagnosticCollection: vscode.DiagnosticCollection
let isInitialScanComplete = false

/**
 * Debug logger for validation - only logs when DEBUG_VALIDATION is true
 */
function debugLog(message: string, ...args: any[]) {
  if (DEBUG_VALIDATION) {
    console.log(`[GTS Validation] ${message}`, ...args)
  }
}

// Load VS Code setting to override debug flag
function loadValidationDebugSetting() {
  try {
    const cfg = vscode.workspace.getConfiguration('gts')
    const v = cfg.get<boolean>('validation.debug', false)
    DEBUG_VALIDATION = !!v
  } catch {
    // ignore
  }
}

/**
 * Convert validation errors to VSCode diagnostics
 */
function validationErrorsToDiagnostics(errors: ValidationError[], document: vscode.TextDocument): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = []

  for (const error of errors) {
    debugLog('Processing error:', {
      keyword: error.keyword,
      instancePath: error.instancePath,
      message: error.message,
      params: error.params
    })

    // Try to find the error location in the document
    let range: vscode.Range

    // Try to find position using instancePath (even if empty) or error-specific logic
    const position = findErrorPosition(document, error.instancePath || '', error)

    if (position) {
      range = position
    } else {
      // Fallback to start of document
      range = new vscode.Range(0, 0, 0, 1)
    }

    const diagnostic = new vscode.Diagnostic(
      range,
      error.message,
      vscode.DiagnosticSeverity.Error
    )

    diagnostic.source = 'GTS'
    diagnostic.code = error.keyword
    diagnostics.push(diagnostic)
  }

  return diagnostics
}

/**
 * Find the range of an error in the document based on instancePath and error details
 */
function findErrorPosition(document: vscode.TextDocument, instancePath: string, error: ValidationError): vscode.Range | null {
  const text = document.getText()

  // Remove leading and trailing slashes from instancePath (e.g., '/users/0/email/' -> 'users/0/email')
  const path = instancePath.replace(/^\//, '').replace(/\/$/, '')

  debugLog(`findErrorPosition enter: keyword='${error.keyword}', instancePath='${instancePath}', normalized='${path}'`)

  // For schema errors, find the object that references the missing schema
  if (error.keyword === 'schema') {

    // If instancePath is empty, search by schemaId in params
    if (!path && error.params && 'schemaId' in error.params) {
      const schemaId = (error.params as any).schemaId as string
      const position = findTypeFieldByValue(text, document, schemaId)
      if (position) {
        debugLog(`findErrorPosition schemaId matched: line=${position.start.line}`)
        return position
      }
    } else if (path) {
      const position = findObjectAtPath(text, document, path)
      if (position) {
        debugLog(`findErrorPosition schema path matched: line=${position.start.line}`)
        return position
      }
    }
  }

  // For additionalProperties errors, look for the actual property mentioned in params
  if (error.keyword === 'additionalProperties' && error.params && 'additionalProperty' in error.params) {
    const additionalProp = (error.params as any).additionalProperty
    const searchPattern = new RegExp(`["']${escapeRegex(additionalProp)}["']\\s*:`, 'g')
    const match = searchPattern.exec(text)
    if (match) {
      const startPos = document.positionAt(match.index + 1) // +1 to skip opening quote
      const endPos = document.positionAt(match.index + 1 + additionalProp.length)
      return new vscode.Range(startPos, endPos)
    }
  }

  // For required property errors, find the parent object and place error at the opening brace
  if (error.keyword === 'required' && error.params && 'missingProperty' in error.params) {
    const missingProp = (error.params as any).missingProperty

    // Try to find the parent object by navigating through the path
    if (!path) {
      // Error at root level - find first opening brace
      const rootMatch = text.match(/\{/)
      if (rootMatch && rootMatch.index !== undefined) {
        const pos = document.positionAt(rootMatch.index)
        debugLog(`findErrorPosition required at root: line=${pos.line}`)
        return new vscode.Range(pos, pos.translate(0, 1))
      }
    } else {
      // Find the object that should contain this property - highlight opening brace
      const position = findObjectAtPath(text, document, path, true)
      if (position) {
        debugLog(`findErrorPosition required at path: path='${path}', line=${position.start.line}`)
        return position
      }
    }
  }

  // General case: navigate to the specific location in the path
  if (path) {
    const position = findPropertyAtPath(text, document, path)
    if (position) {
      debugLog(`findErrorPosition general path matched: path='${path}', line=${position.start.line}`)
      return position
    }
  }

  // Fallback: return null to use default position
  debugLog(`findErrorPosition no match for path='${path}', returning null`)
  return null
}

/**
 * Find a "type" field with a specific value in the JSON
 * Returns a range highlighting the "type" field name
 */
function findTypeFieldByValue(text: string, document: vscode.TextDocument, typeValue: string): vscode.Range | null {
  debugLog(`findTypeFieldByValue enter: value='${typeValue}'`)

  // Escape the typeValue for use in regex
  const escapedValue = escapeRegex(typeValue)

  // Search for: "type": "typeValue"
  const searchPattern = new RegExp(`"type"\\s*:\\s*"${escapedValue}"`, 'g')
  const match = searchPattern.exec(text)

  if (match) {
    // Highlight the "type" property name (not the value)
    const typeKeyStart = match.index + 1 // +1 to skip opening quote
    const typeKeyEnd = match.index + 5 // "type" is 4 characters, +1 for the quote

    const startPos = document.positionAt(typeKeyStart)
    const endPos = document.positionAt(typeKeyEnd)

    debugLog(`findTypeFieldByValue found at line=${startPos.line}`)
    return new vscode.Range(startPos, endPos)
  }

  debugLog('findTypeFieldByValue not found')
  return null
}

/**
 * Find an object in the JSON at the given path (handles array indices)
 * Returns a range highlighting the object's "id" or "type" field, or opening brace
 */
function findObjectAtPath(text: string, document: vscode.TextDocument, path: string, highlightBrace: boolean = false): vscode.Range | null {
  debugLog(`findObjectAtPath enter: path='${path}', highlightBrace=${highlightBrace}`)
  if (!path) {
    // Root level - find first opening brace
    const rootMatch = text.match(/\{/)
    if (rootMatch && rootMatch.index !== undefined) {
      const pos = document.positionAt(rootMatch.index)
      debugLog(`findObjectAtPath root brace at line=${pos.line}`)
      return new vscode.Range(pos, pos.translate(0, 1))
    }
    return null
  }

  const segments = path.split('/')

  // Check if we're dealing with an array index at the root or deeper level
  if (segments.length === 1 && /^\d+$/.test(segments[0])) {
    // Root-level array, e.g., path = "1" means second item in array
    const arrayIndex = parseInt(segments[0], 10)
    const range = findNthObjectInArray(text, document, arrayIndex, highlightBrace)
    if (range) debugLog(`findObjectAtPath array index=${arrayIndex} line=${range.start.line}`)
    return range
  }

  // For nested paths, navigate through the structure
  // For now, handle the simple case of array indices
  const lastSegment = segments[segments.length - 1]
  if (/^\d+$/.test(lastSegment)) {
    const arrayIndex = parseInt(lastSegment, 10)
    const range = findNthObjectInArray(text, document, arrayIndex)
    if (range) debugLog(`findObjectAtPath lastSegment index=${arrayIndex} line=${range.start.line}`)
    return range
  }

  // Try to find a property by name
  const searchPattern = new RegExp(`["']${escapeRegex(lastSegment)}["']\\s*:\\s*\\{`, 'g')
  const match = searchPattern.exec(text)
  if (match) {
    const pos = document.positionAt(match.index + 1)
    const endPos = document.positionAt(match.index + 1 + lastSegment.length)
    debugLog(`findObjectAtPath property '${lastSegment}' at line=${pos.line}`)
    return new vscode.Range(pos, endPos)
  }

  debugLog(`findObjectAtPath not found for path='${path}'`)
  return null
}

/**
 * Find a property at a specific path in the JSON
 * Handles nested paths like "2/payload/orderId"
 */
function findPropertyAtPath(text: string, document: vscode.TextDocument, path: string): vscode.Range | null {
  const segments = path.split('/')
  debugLog(`findPropertyAtPath enter: path='${path}', segments=${JSON.stringify(segments)}`)

  // If the first segment is a number, we need to find that object in the array first
  if (segments.length > 0 && /^\d+$/.test(segments[0])) {
    const arrayIndex = parseInt(segments[0], 10)
    debugLog(`findPropertyAtPath root index=${arrayIndex}`)

    // For nested paths, we need the object's opening brace position, not a field position
    if (segments.length > 1) {
      const objectBracePos = findNthObjectBracePosition(text, document, arrayIndex)

      if (!objectBracePos) {
        debugLog(`findPropertyAtPath could not locate object at index=${arrayIndex}`)
        return null
      }

      // Get the object's text range
      const objectStart = document.offsetAt(objectBracePos.start)
      const objectText = findObjectTextAtPosition(text, objectStart)

      if (!objectText) {
        debugLog(`findPropertyAtPath could not extract object text at index=${arrayIndex}`)
        return null
      }

      // Now search for the remaining path within this object
      const remainingPath = segments.slice(1).join('/')
      const range = findPropertyInText(objectText.text, document, objectText.startOffset, remainingPath)
      if (range) debugLog(`findPropertyAtPath found '${remainingPath}' at line=${range.start.line}`)
      return range
    } else {
      // Just return the object position (for display purposes)
      return findNthObjectInArray(text, document, arrayIndex, false)
    }
  }

  // No array index, just search for the property path
  const range = findPropertyInText(text, document, 0, path)
  if (range) debugLog(`findPropertyAtPath found '${path}' at line=${range.start.line}`)
  return range
}

/**
 * Find the opening brace position of the Nth object in a root-level array
 * Returns just the position, not a field within the object
 */
function findNthObjectBracePosition(text: string, document: vscode.TextDocument, index: number): vscode.Range | null {
  debugLog(`findNthObjectBracePosition enter: index=${index}`)
  // Skip whitespace and find array start
  let pos = 0
  while (pos < text.length && /\s/.test(text[pos])) pos++

  if (pos >= text.length || text[pos] !== '[') {
    debugLog('findNthObjectBracePosition no root array')
    return null
  }

  pos++ // Skip '['

  let braceCount = 0
  let bracketCount = 0
  let objectCount = 0
  let currentObjectStart = -1
  let inString = false
  let escapeNext = false

  for (let i = pos; i < text.length; i++) {
    const char = text[i]

    // Handle string escaping
    if (escapeNext) {
      escapeNext = false
      continue
    }
    if (char === '\\' && inString) {
      escapeNext = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    // Track brackets and braces
    if (char === '[') {
      bracketCount++
    } else if (char === ']') {
      if (bracketCount > 0) {
        bracketCount--
      } else {
        // End of root array
        break
      }
    } else if (char === '{') {
      if (braceCount === 0 && bracketCount === 0) {
        // Start of a new object at array level
        currentObjectStart = i

        if (objectCount === index) {
          // Found the target object, return its opening brace position
          const objPos = document.positionAt(currentObjectStart)
          const range = new vscode.Range(objPos, objPos.translate(0, 1))
          debugLog(`findNthObjectBracePosition found: line=${range.start.line}`)
          return range
        }
      }
      braceCount++
    } else if (char === '}') {
      braceCount--
      if (braceCount === 0 && bracketCount === 0) {
        // End of object at array level
        objectCount++
      }
    }
  }

  return null
}

/**
 * Find the text content of an object starting at a given position
 */
function findObjectTextAtPosition(text: string, startPos: number): { text: string; startOffset: number } | null {
  debugLog(`findObjectTextAtPosition enter: startPos=${startPos}`)
  let braceCount = 0
  let inString = false
  let escapeNext = false
  let objectStart = -1

  // Find the opening brace
  for (let i = startPos; i < text.length; i++) {
    const char = text[i]
    if (char === '{') {
      objectStart = i
      braceCount = 1
      break
    }
  }

  if (objectStart === -1) {
    debugLog('findObjectTextAtPosition no opening brace found')
    return null
  }

  // Find the closing brace
  for (let i = objectStart + 1; i < text.length; i++) {
    const char = text[i]

    if (escapeNext) {
      escapeNext = false
      continue
    }
    if (char === '\\' && inString) {
      escapeNext = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (char === '{') {
      braceCount++
    } else if (char === '}') {
      braceCount--
      if (braceCount === 0) {
        const result = {
          text: text.substring(objectStart, i + 1),
          startOffset: objectStart
        }
        debugLog(`findObjectTextAtPosition extracted: length=${result.text.length}, startOffset=${result.startOffset}`)
        return result
      }
    }
  }

  return null
}

/**
 * Find a property in text by navigating through a path like "payload/orderId"
 */
function findPropertyInText(text: string, document: vscode.TextDocument, baseOffset: number, path: string): vscode.Range | null {
  debugLog(`findPropertyInText enter: path='${path}', baseOffset=${baseOffset}`)

  const segments = path.split('/').filter(s => s.length > 0 && !/^\d+$/.test(s))
  debugLog(`findPropertyInText segments=${JSON.stringify(segments)}`)

  if (segments.length === 0) {
    return null
  }

  let currentText = text
  let currentOffset = baseOffset

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    debugLog(`findPropertyInText search segment='${segment}'`)

    // Find the property in the current text
    const searchPattern = new RegExp(`["']${escapeRegex(segment)}["']\\s*:`, 'g')
    const match = searchPattern.exec(currentText)

    if (!match || match.index === undefined) {
      debugLog(`findPropertyInText segment not found='${segment}'`)
      return null
    }

    const propertyOffset = currentOffset + match.index
    debugLog(`findPropertyInText segment found='${segment}', propertyOffset=${propertyOffset}`)

    // If this is the last segment, return its position
    if (i === segments.length - 1) {
      const startPos = document.positionAt(propertyOffset + 1) // +1 to skip opening quote
      const endPos = document.positionAt(propertyOffset + 1 + segment.length)
      const range = new vscode.Range(startPos, endPos)
      debugLog(`findPropertyInText final segment range line=${range.start.line}`)
      return range
    }

    // Otherwise, find the value of this property and continue searching within it
    const valueStart = currentOffset + match.index + match[0].length
    const valueText = findPropertyValueText(currentText.substring(match.index + match[0].length))

    if (!valueText) {
      debugLog(`findPropertyInText could not extract value text for segment='${segment}'`)
      return null
    }

    currentText = valueText
    currentOffset = valueStart
  }

  return null
}

/**
 * Extract the value text of a property (object or primitive)
 */
function findPropertyValueText(text: string): string | null {
  let i = 0

  // Skip whitespace
  while (i < text.length && /\s/.test(text[i])) i++

  if (i >= text.length) return null

  const firstChar = text[i]

  // If it's an object, extract the whole object
  if (firstChar === '{') {
    let braceCount = 0
    let inString = false
    let escapeNext = false
    let start = i

    for (; i < text.length; i++) {
      const char = text[i]

      if (escapeNext) {
        escapeNext = false
        continue
      }
      if (char === '\\' && inString) {
        escapeNext = true
        continue
      }
      if (char === '"') {
        inString = !inString
        continue
      }
      if (inString) continue

      if (char === '{') {
        braceCount++
      } else if (char === '}') {
        braceCount--
        if (braceCount === 0) {
          return text.substring(start, i + 1)
        }
      }
    }
  }

  // For other types, we don't need to navigate further
  return null
}

/**
 * Find the Nth object in a root-level array
 * Highlights the object's "id" or "type" field, or opening brace
 */
function findNthObjectInArray(text: string, document: vscode.TextDocument, index: number, highlightBrace: boolean = false): vscode.Range | null {
  debugLog(`findNthObjectInArray enter: index=${index}, highlightBrace=${highlightBrace}`)

  // Skip whitespace and find array start
  let pos = 0
  while (pos < text.length && /\s/.test(text[pos])) pos++

  if (pos >= text.length || text[pos] !== '[') {
    return null
  }

  pos++ // Skip '['

  let braceCount = 0
  let bracketCount = 0
  let objectCount = 0
  let currentObjectStart = -1
  let inString = false
  let escapeNext = false

  for (let i = pos; i < text.length; i++) {
    const char = text[i]

    // Handle string escaping
    if (escapeNext) {
      escapeNext = false
      continue
    }
    if (char === '\\' && inString) {
      escapeNext = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    // Track brackets and braces
    if (char === '[') {
      bracketCount++
    } else if (char === ']') {
      if (bracketCount > 0) {
        bracketCount--
      } else {
        // End of root array
        break
      }
    } else if (char === '{') {
      if (braceCount === 0 && bracketCount === 0) {
        // Start of a new object at array level
        currentObjectStart = i

        if (objectCount === index) {
          // Found the target object, now find its "id" or "type" field
          const objectText = text.substring(currentObjectStart, i + 1)

          // If highlightBrace is true, always highlight the opening brace
          if (highlightBrace) {
            const objPos = document.positionAt(currentObjectStart)
            const range = new vscode.Range(objPos, objPos.translate(0, 1))
            debugLog(`findNthObjectInArray highlightBrace returning line=${range.start.line}`)
            return range
          }

          // Try to find "id" field first
          const idMatch = objectText.match(/"id"\s*:\s*"([^"]+)"/)
          if (idMatch && idMatch.index !== undefined) {
            const idStartPos = document.positionAt(currentObjectStart + idMatch.index + 1) // +1 to skip opening quote
            const idEndPos = document.positionAt(currentObjectStart + idMatch.index + 3) // "id" length
            const range = new vscode.Range(idStartPos, idEndPos)
            debugLog(`findNthObjectInArray id field line=${range.start.line}`)
            return range
          }

          // Try "type" field as fallback
          const typeMatch = objectText.match(/"type"\s*:\s*"([^"]+)"/)
          if (typeMatch && typeMatch.index !== undefined) {
            const typeStartPos = document.positionAt(currentObjectStart + typeMatch.index + 1)
            const typeEndPos = document.positionAt(currentObjectStart + typeMatch.index + 5) // "type" length
            const range = new vscode.Range(typeStartPos, typeEndPos)
            debugLog(`findNthObjectInArray type field line=${range.start.line}`)
            return range
          }

          // Fallback: highlight opening brace
          const objPos = document.positionAt(currentObjectStart)
          const range = new vscode.Range(objPos, objPos.translate(0, 1))
          debugLog(`findNthObjectInArray fallback brace line=${range.start.line}`)
          return range
        }
      }
      braceCount++
    } else if (char === '}') {
      braceCount--
      if (braceCount === 0 && bracketCount === 0) {
        // End of object at array level
        objectCount++
      }
    }
  }

  debugLog(`findNthObjectInArray not found for index=${index}`)
  return null
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Validate a document and update diagnostics
 */
export async function validateOpenDocument(document: vscode.TextDocument) {
  if (!isGtsCandidateFile(document)) {
    return
  }

  try {
    const text = document.getText()
    const fileName = path.basename(document.fileName)
    const filePath = document.uri.fsPath
    debugLog(`Validating: ${filePath}`)

    // Parse the document content to JSON
    let content: any
    try {
      content = parseJSONC(text)
    } catch (parseError: any) {
      // If parsing fails, store as text and let registry handle it
      content = text
    }

    const files = getLastScanFiles()

    const withoutCurrent = files.filter(f => f.path !== filePath)
    const merged = [...withoutCurrent, { path: filePath, name: fileName, content }]
    debugLog(`Ingesting ${merged.length} files into GTS registry...`)

    const registry = new JsonRegistry()
    await registry.ingestFiles(merged, DEFAULT_GTS_CONFIG)

    let errors: ValidationError[] = []

    const invalid = registry.invalidFiles.get(filePath)

    if (invalid?.validation && invalid.validation.errors.length > 0) {
      errors = invalid.validation.errors
    } else {
      const fileObjs = Array.from(registry.jsonObjs.values()).filter(o => o.file?.path === filePath)
      const fileSchemas = Array.from(registry.jsonSchemas.values()).filter(s => s.file?.path === filePath)
      debugLog(`Found ${fileObjs.length} objects and ${fileSchemas.length} schemas in file`)

      for (const e of [...fileObjs, ...fileSchemas]) {
        if (e.validation && e.validation.errors.length > 0) {
          // If the entity is part of an array (has listSequence), prefix the instancePath with the array index
          if (e.listSequence !== undefined) {
            const adjustedErrors = e.validation.errors.map(err => {
              // Normalize the instancePath: remove leading slash if present, then add the array index
              const normalizedPath = err.instancePath.replace(/^\//, '')
              const newPath = normalizedPath ? `/${e.listSequence}/${normalizedPath}` : `/${e.listSequence}`
              return {
                ...err,
                instancePath: newPath
              }
            })
            errors.push(...adjustedErrors)
          } else {
            errors.push(...e.validation.errors)
          }
        }
      }
    }

    if (errors.length > 0) {
      const diagnostics = validationErrorsToDiagnostics(errors, document)
      diagnosticCollection.set(document.uri, diagnostics)
      debugLog(`Set ${diagnostics.length} diagnostics for ${fileName}`)
    } else {
      diagnosticCollection.delete(document.uri)
      debugLog(`Cleared diagnostics for ${fileName}`)
    }
  } catch (error) {
    diagnosticCollection.delete(document.uri)
    debugLog(`Error validating document: ${String(error)}`)
  }
}

export function initValidation(context: vscode.ExtensionContext) {
    // Load debug flag from settings and listen to changes
    loadValidationDebugSetting()
    debugLog('Initializing validation system...')
    // Create diagnostic collection for validation errors
    diagnosticCollection = vscode.languages.createDiagnosticCollection('gts')
    context.subscriptions.push(diagnosticCollection)

    // Validate all open documents on activation
    const openDocs = vscode.workspace.textDocuments
    openDocs.forEach(doc => {
      void validateOpenDocument(doc)
    })

    // Validate document when it's opened
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(doc => {
        if (!isGtsCandidateFile(doc)) return
        void validateOpenDocument(doc)
      })
    )

    // Clear diagnostics when document is closed
    context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument(doc => {
        if (!isGtsCandidateFile(doc)) return
        diagnosticCollection.delete(doc.uri)
      })
    )

    // React to settings changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('gts.validation.debug')) {
          loadValidationDebugSetting()
          debugLog(`Validation debug is now ${DEBUG_VALIDATION ? 'ON' : 'OFF'}`)
        }
      })
    )
}
