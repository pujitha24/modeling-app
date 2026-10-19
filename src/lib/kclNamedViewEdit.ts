import type { Node } from '@rust/kcl-lib/bindings/Node'

import { toUtf16 } from '@src/lang/errors'
import { createModelingCodemodActor } from '@src/lang/modifyAst/modelingCodemod'
import { isOrientedCameraCall } from '@src/lang/modifyAst/namedViews'
import {
  getNodeFromPath,
  retrieveSelectionsFromArtifactIds,
} from '@src/lang/queryAst'
import type {
  ArtifactGraph,
  CallExpressionKw,
  KclNamedViewArtifact,
  Program,
} from '@src/lang/wasm'
import { ROOT_MODULE_ID } from '@src/lang/wasm'
import { getArtifactsMatchingPathToNode } from '@src/lang/std/artifactGraph'
import { modelingCommandCodemods } from '@src/lib/commandBarConfigs/modelingCommandCodemods'
import type { ModelingCommandSchema } from '@src/lib/commandBarConfigs/modelingCommandConfig'
import { STD_LIB_ENUMS } from '@src/lib/commandBarConfigs/modelingCommandStdLibCommands'
import type { KclCommandValue } from '@src/lib/commandTypes'
import { stringToKclExpression } from '@src/lib/kclHelpers'
import { activeViewSignal, moduleKeyOf } from '@src/lib/kclNamedViewActivation'
import type RustContext from '@src/lib/rustContext'
import { isErr } from '@src/lib/trap'
import type { CommandBarMachineEvent } from '@src/machines/commandBarMachine'

const submitNamedView = createModelingCodemodActor(
  modelingCommandCodemods['Named View']
)

export const submitNamedViewCommand: typeof submitNamedView = async (
  options
) => {
  const { input } = options
  const data = input?.data
  const active = activeViewSignal.peek()
  if (!input || !data?.nodeToEdit || !active || data.name === active.name) {
    return submitNamedView(options)
  }

  const view = getArtifactsMatchingPathToNode(
    data.nodeToEdit,
    input.kclManager.artifactGraph
  ).find(
    (artifact) =>
      artifact.type === 'namedView' &&
      artifact.codeRef.range[2] === ROOT_MODULE_ID
  )
  if (
    view?.type !== 'namedView' ||
    view.name !== active.name ||
    active.moduleKey !==
      moduleKeyOf(input.kclManager.execState.filenames[ROOT_MODULE_ID])
  ) {
    return submitNamedView(options)
  }

  // Execution reapplies the active view by name, so keep its identity in sync.
  const renamed = { ...active, name: data.name }
  activeViewSignal.value = renamed
  try {
    await submitNamedView(options)
  } catch (error) {
    if (activeViewSignal.peek() === renamed) activeViewSignal.value = active
    return Promise.reject(error)
  }
}

export async function prepareNamedViewEditCommand({
  artifact,
  artifactGraph,
  ast,
  code,
  rustContext,
}: {
  artifact: KclNamedViewArtifact
  artifactGraph: ArtifactGraph
  ast: Node<Program>
  code: string
  rustContext: RustContext
}) {
  const callResult = getNodeFromPath<CallExpressionKw>(
    ast,
    artifact.codeRef.pathToNode,
    await rustContext.wasmInstancePromise,
    'CallExpressionKw'
  )
  if (isErr(callResult)) return callResult

  const camera = callResult.node.arguments.find(
    (argument) => argument.label?.name === 'camera'
  )?.arg
  const orientedCamera = isOrientedCameraCall(camera) ? camera : undefined
  const extractCameraArgument = async (
    name: 'target' | 'distance'
  ): Promise<KclCommandValue | undefined | Error> => {
    if (!orientedCamera) {
      return undefined
    }
    const argument = orientedCamera.arguments.find(
      (candidate) => candidate.label?.name === name
    )?.arg
    if (!argument) {
      return undefined
    }

    const source = code.slice(
      toUtf16(argument.start, code),
      toUtf16(argument.end, code)
    )
    const result = await stringToKclExpression(source, rustContext)
    if (isErr(result) || 'errors' in result) {
      return new Error(`Could not read the named view ${name} argument.`)
    }
    return result
  }

  const target = await extractCameraArgument('target')
  if (isErr(target)) {
    return target
  }

  const distance = await extractCameraArgument('distance')
  if (isErr(distance)) {
    return distance
  }

  const exceptIds =
    artifact.baseline === 'show' ? artifact.hideIds : artifact.showIds
  const except =
    exceptIds.length > 0
      ? retrieveSelectionsFromArtifactIds(exceptIds, artifactGraph)
      : undefined

  // Other camera expressions stay in source; only name and visibility are editable.
  const look = artifact.camera.look
  const orientation =
    orientedCamera && look.type === 'oriented'
      ? STD_LIB_ENUMS['view::Orientation'].find(
          (value) => value.toLowerCase() === look.orientation
        )
      : undefined
  const argDefaultValues: ModelingCommandSchema['Named View'] = {
    name: artifact.name,
    orientation,
    target,
    distance,
    projection: orientation
      ? artifact.camera.projection === 'orthographic'
        ? 'Orthographic'
        : 'Perspective'
      : undefined,
    baseline: artifact.baseline === 'show' ? 'Show' : 'Hide',
    // Selection reconstruction is best-effort; edits preserve the original except expression.
    except: isErr(except) ? undefined : except,
    nodeToEdit: structuredClone(artifact.codeRef.pathToNode),
  }

  return {
    type: 'Find and select command',
    data: {
      name: 'Named View',
      groupId: 'modeling',
      argDefaultValues,
    },
  } satisfies CommandBarMachineEvent
}
