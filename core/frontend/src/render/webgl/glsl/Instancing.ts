/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/
/** @module WebGL */

import { assert } from "@bentley/bentleyjs-core";
import { GL } from "../GL";
import { VertexShaderBuilder, VariableType } from "../ShaderBuilder";
import { addOvrFlagConstants } from "./FeatureSymbology";
import { GLSLCommon } from "./Common";

const extractInstanceBit = `
  float extractInstanceBit(float flag) { return extractNthBit(a_instanceOverrides.r, flag); }
`;

const computeInstancedModelMatrix = `
  mat4 instanceMatrix = mat4(
    a_instanceMatrixRow0.x, a_instanceMatrixRow1.x, a_instanceMatrixRow2.x, 0.0,
    a_instanceMatrixRow0.y, a_instanceMatrixRow1.y, a_instanceMatrixRow2.y, 0.0,
    a_instanceMatrixRow0.z, a_instanceMatrixRow1.z, a_instanceMatrixRow2.z, 0.0,
    a_instanceMatrixRow0.w, a_instanceMatrixRow1.w, a_instanceMatrixRow2.w, 1.0);
  g_modelMatrix = instanceMatrix * u_rootModelMatrix;
`;

function addInstanceMatrixRow(vert: VertexShaderBuilder, row: number) {
  // 3 rows per instance; 4 floats per row; 4 bytes per float.
  const floatsPerRow = 4;
  const bytesPerVertex = floatsPerRow * 4;
  const offset = row * bytesPerVertex;
  const stride = 3 * bytesPerVertex;
  const name = "a_instanceMatrixRow" + row;
  vert.addAttribute(name, VariableType.Vec4, (prog) => {
    prog.addAttribute(name, (attr, params) => {
      const geom = params.geometry.asInstanced!;
      assert(undefined !== geom);
      attr.enableArray(geom.transforms, floatsPerRow, GL.DataType.Float, false, stride, offset, true);
    });
  });
}

export function addInstancedModelMatrix(vert: VertexShaderBuilder) {
  assert(vert.usesInstancedGeometry);

  // ###TODO_INSTANCING: We can make this more efficient, reduce amount of data sent as uniforms and attributes, and reduce computation on the GPU.
  // Get it working the straightforward way first.
  vert.addUniform("u_rootModelMatrix", VariableType.Mat4, (prog) => {
    // ###TODO_INSTANCING: We only need 3 rows, not 4...
    prog.addGraphicUniform("u_rootModelMatrix", (uniform, params) => {
      uniform.setMatrix4(params.modelMatrix);
    });
  });

  addInstanceMatrixRow(vert, 0);
  addInstanceMatrixRow(vert, 1);
  addInstanceMatrixRow(vert, 2);

  vert.addGlobal("g_modelMatrix", VariableType.Mat4);
  vert.addInitializer(computeInstancedModelMatrix);
}

export function addInstanceOverrides(vert: VertexShaderBuilder): void {
  if (undefined !== vert.find("a_instanceOverrides"))
    return;

  addOvrFlagConstants(vert);

  vert.addFunction(GLSLCommon.extractNthBit);
  vert.addFunction(extractInstanceBit);

  vert.addAttribute("a_instanceOverrides", VariableType.Vec4, (prog) => {
    prog.addAttribute("a_instanceOverrides", (attr, params) => {
      const geom = params.geometry.asInstanced!;
      assert(undefined !== geom);

      // NB: If none defined, attribute access returns constant values.
      // This is *context* state. Apparently it defaults to (0, 0, 0, 1). Which is fine for us since r=0 means nothing overridden.
      if (undefined !== geom.symbology)
        attr.enableArray(geom.symbology, 4, GL.DataType.UnsignedByte, false, 8, 0, true);
    });
  });
}

export function addInstanceColor(vert: VertexShaderBuilder): void {
  addInstanceOverrides(vert);

  vert.addAttribute("a_instanceRgba", VariableType.Vec4, (prog) => {
    prog.addAttribute("a_instanceRgba", (attr, params) => {
      const geom = params.geometry.asInstanced!;
      if (undefined !== geom.symbology)
        attr.enableArray(geom.symbology, 4, GL.DataType.UnsignedByte, false, 8, 4, true);
    });
  });
}
