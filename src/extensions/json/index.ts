import path from 'path'
import {CancellationToken, CompletionContext, CompletionItem, CompletionList, Position, TextDocument} from 'vscode-languageserver-protocol'
import {ProviderResult} from '../../provider'
import {LanguageService} from '../../language-client'
import {ROOT} from '../../util'
import workspace from '../../workspace'
import catalog from './catalog.json'
import {LanguageClientOptions, ProvideCompletionItemsSignature} from '../../language-client/main'
import Uri from 'vscode-uri'
import {readdirAsync, resolveRoot} from '../../util/fs'
import { LanguageServerConfig } from '../../types'
const logger = require('../../util/logger')('extension-json')

interface ISchemaAssociations {
  [pattern: string]: string[]
}

const ID = 'json'
export default class JsonService extends LanguageService {
  private miniProgrameRoot:string

  constructor() {
    const config = workspace.getConfiguration().get(ID) as LanguageServerConfig
    super('json', 'JSON Language Server', {
      module: path.join(ROOT, 'node_modules/vscode-json-languageserver/out/jsonServerMain.js'),
      args: ['--node-ipc'],
      execArgv: config.execArgv,
      filetypes: config.filetypes || ['json', 'jsonc'],
      enable: config.enable !== false
    }, ['json', 'http'])
  }

  private async onDocumentEnter(uri:string):Promise<void> {
    if (!/\.json$/.test(uri)) return
    let {miniProgrameRoot} = this
    let doc = workspace.getDocument(uri)
    if (!doc) return
    let file = Uri.parse(uri).fsPath
    let associations:ISchemaAssociations = {}
    let {content} = doc
    if (content.indexOf('$schema') !== -1) return
    if (miniProgrameRoot) {
      if (path.dirname(file) == miniProgrameRoot) {
        return
      }
      let arr = ['page', 'component'].map(str => {
        return Uri.file(path.join(ROOT, `data/${str}.json`)).toString()
      })
      associations[file] = arr
    }
    if (Object.keys(associations).length > 0) {
      this.client.sendNotification('json/schemaAssociations', associations)
    }
  }

  public checkMiniProgram():void {
    let {root} = workspace
    this.miniProgrameRoot = resolveRoot(root, ['project.config.json'])
  }

  public async init(): Promise<void> {
    await super.init()
    this.checkMiniProgram()
    let associations: ISchemaAssociations = {}
    for (let item of catalog.schemas) {
      let {fileMatch, url} = item
      if (Array.isArray(fileMatch)) {
        for (let key of fileMatch) {
          associations[key] = [url]
        }
      } else if (typeof fileMatch === 'string') {
        associations[fileMatch] = [url]
      }
    }
    const files = await this.getSchemaFiles()
    associations['coc-settings.json'] = files.map(f => Uri.file(f).toString())
    associations['app.json'] = [Uri.file(path.join(ROOT, 'data/app.json')).toString()]
    this.client.sendNotification('json/schemaAssociations', associations)
    this.disposables.push(
      workspace.onDidEnterTextDocument(documentInfo => {
        let {uri} = documentInfo
        this.onDocumentEnter(uri)
      })
    )
    for (let document of workspace.documents) {
      this.onDocumentEnter(document.uri)
    }
  }

  private async getSchemaFiles(): Promise<string[]> {
    const files = [path.join(ROOT, 'data/schema.json')]
    try {
      const base = path.join(ROOT, 'src/extensions')
      const folders = await readdirAsync(base)
      files.push(...folders.map(f => path.join(base, f + '/schema.json')))
    } catch (e) {
      logger.error(e.message)
    }
    return files
  }

  protected resolveClientOptions(clientOptions: LanguageClientOptions): LanguageClientOptions {
    Object.assign(clientOptions, {
      middleware: {
        // fix completeItem
        provideCompletionItem: (
          document: TextDocument,
          position: Position,
          context: CompletionContext,
          token: CancellationToken,
          next: ProvideCompletionItemsSignature
        ): ProviderResult<CompletionItem[] | CompletionList> => {
          return Promise.resolve(next(document, position, context, token)).then((res: CompletionItem[] | CompletionList) => {
            let doc = workspace.getDocument(document.uri)
            if (!doc) return []
            let items: CompletionItem[] = res.hasOwnProperty('isIncomplete') ? (res as CompletionList).items : res as CompletionItem[]
            for (let item of items) {
              let {textEdit, insertText, label} = item // tslint:disable-line
              item.insertText = null // tslint:disable-line
              if (textEdit && textEdit.newText) {
                let newText = insertText || textEdit.newText
                textEdit.newText = newText.replace(/(\n|\t)/g, '')
                let {start, end} = textEdit.range
                let line = doc.getline(position.line)
                if (line[start.character] && line[end.character - 1] && /^".*"$/.test(label)) {
                  item.label = item.label.slice(1, -1)
                }
              }
            }
            return items
          })
        }
      }
    })
    return clientOptions
  }
}