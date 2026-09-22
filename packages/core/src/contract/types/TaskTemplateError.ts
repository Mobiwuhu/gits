import { GitsError } from './GitsError'

export class TaskTemplateNameError extends GitsError {
  constructor(name: string) {
    super(
      'template-name-invalid',
      `Template name '${name}' must be 1-63 lowercase ASCII letters, digits, or non-edge hyphens.`,
      2
    )
    this.name = 'TaskTemplateNameError'
  }
}

export class TaskTemplateAlreadyExistsError extends GitsError {
  constructor(name: string) {
    super('template-already-exists', `Template '${name}' already exists.`, 2)
    this.name = 'TaskTemplateAlreadyExistsError'
  }
}

export class UnknownTaskTemplateError extends GitsError {
  constructor(name: string) {
    super('template-not-found', `Template '${name}' does not exist.`, 2)
    this.name = 'UnknownTaskTemplateError'
  }
}

export class BuiltInTaskTemplateReadonlyError extends GitsError {
  constructor() {
    super(
      'template-built-in-readonly',
      "The built-in 'default' template cannot be modified or removed.",
      2
    )
    this.name = 'BuiltInTaskTemplateReadonlyError'
  }
}

export class TaskTemplateBusyError extends GitsError {
  constructor(names: readonly string[]) {
    super(
      'template-lock-busy',
      `Task template ${names.map((name) => `'${name}'`).join(', ')} is being modified by another process.`,
      1
    )
    this.name = 'TaskTemplateBusyError'
  }
}

export class TaskTemplateUsageError extends GitsError {
  constructor(message: string) {
    super('template-usage-error', message, 2)
    this.name = 'TaskTemplateUsageError'
  }
}
