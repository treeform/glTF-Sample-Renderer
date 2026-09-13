import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// Run with: node --test tests/skinned-transforms.test.mjs
// CHROMIUM_EXECUTABLE optionally selects an already installed browser.
test('skinned vertex outputs ignore the mesh transform, including zero scale', async () => {
    const primitive = await readFile(new URL('../source/Renderer/shaders/primitive.vert', import.meta.url), 'utf8');
    const animation = await readFile(new URL('../source/Renderer/shaders/animation.glsl', import.meta.url), 'utf8');
    const source = primitive.replace('#include <animation.glsl>', animation);
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE });
    try {
        const page = await browser.newPage();
        const results = await page.evaluate((source) => {
            const gl = document.createElement('canvas').getContext('webgl2');
            if (!gl) throw new Error('WebGL 2 is required');
            const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
            const rotation = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
            const zeroScale = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
            // A world-space joint rotation about Y. Its normal matrix is the
            // same rotation. This matches skin.js's joint texture contract.
            const joint = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
            const texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 2, 4, 0, gl.RGBA, gl.FLOAT, new Float32Array([...joint, ...joint]));
            const results = [];
            for (const skinning of [true, false]) {
                for (const tangents of [false, true]) {
                    let defines = '#version 300 es\nprecision highp float;\nprecision highp int;\n#define DEBUG_VERT -1\n#define DEBUG_VERT_TANGENT_W 1\n#define HAS_NORMAL_VEC3\n';
                    if (skinning) defines += '#define USE_SKINNING\n#define HAS_JOINTS_0_VEC4\n#define HAS_WEIGHTS_0_VEC4\n';
                    if (tangents) defines += '#define HAS_TANGENT_VEC4\n';
                    const compile = (type, text) => {
                        const shader = gl.createShader(type);
                        gl.shaderSource(shader, text);
                        gl.compileShader(shader);
                        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
                        return shader;
                    };
                    const program = gl.createProgram();
                    gl.attachShader(program, compile(gl.VERTEX_SHADER, defines + source));
                    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;\nout vec4 color; void main() { color = vec4(1); }'));
                    gl.transformFeedbackVaryings(program, ['v_Position', tangents ? 'v_TBN' : 'v_Normal'], gl.INTERLEAVED_ATTRIBS);
                    gl.linkProgram(program);
                    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
                    gl.useProgram(program);
                    const attribute = (name, values) => {
                        const location = gl.getAttribLocation(program, name);
                        if (location >= 0) gl.vertexAttrib4fv(location, values);
                    };
                    attribute('a_position', [1, 2, 3, 1]);
                    attribute('a_normal', [0, 0, 1, 0]);
                    attribute('a_tangent', [1, 0, 0, -1]);
                    attribute('a_joints_0', [0, 0, 0, 0]);
                    attribute('a_weights_0', [1, 0, 0, 0]);
                    gl.uniform1i(gl.getUniformLocation(program, 'u_jointsSampler'), 0);
                    gl.uniformMatrix4fv(gl.getUniformLocation(program, 'u_ViewProjectionMatrix'), false, identity);
                    for (const [name, matrix] of [['identity', identity], ['rotation', rotation], ...(skinning ? [['zero scale', zeroScale]] : [])]) {
                        gl.uniformMatrix4fv(gl.getUniformLocation(program, 'u_ModelMatrix'), false, matrix);
                        // Zero scale has no inverse. Poison the unused normal
                        // matrix to ensure skinning does not depend on it.
                        const normalMatrix = name === 'zero scale' ? Array(16).fill(NaN) : matrix;
                        gl.uniformMatrix4fv(gl.getUniformLocation(program, 'u_NormalMatrix'), false, normalMatrix);
                        const buffer = gl.createBuffer();
                        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, buffer);
                        const values = new Float32Array(tangents ? 12 : 6);
                        gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, values.byteLength, gl.STREAM_READ);
                        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, buffer);
                        gl.enable(gl.RASTERIZER_DISCARD);
                        gl.beginTransformFeedback(gl.POINTS);
                        gl.drawArrays(gl.POINTS, 0, 1);
                        gl.endTransformFeedback();
                        gl.disable(gl.RASTERIZER_DISCARD);
                        gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, values);
                        if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL transform feedback failed');
                        results.push({ skinning, tangents, name, values: Array.from(values) });
                        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
                        gl.deleteBuffer(buffer);
                    }
                    gl.deleteProgram(program);
                }
            }
            return results;
        }, source);
        for (const result of results) {
            const { skinning, tangents, name, values } = result;
            const position = skinning ? [3, 2, -1] : name === 'rotation' ? [-2, 1, 3] : [1, 2, 3];
            const normal = skinning ? [1, 0, 0] : [0, 0, 1];
            const tangent = skinning ? [0, 0, -1] : name === 'rotation' ? [0, 1, 0] : [1, 0, 0];
            const bitangent = !skinning && name === 'rotation' ? [1, 0, 0] : [0, -1, 0];
            const expected = [...position, ...(tangents ? [...tangent, ...bitangent, ...normal] : normal)];
            for (let i = 0; i < expected.length; i++) {
                assert.ok(Number.isFinite(values[i]) && Math.abs(values[i] - expected[i]) < 1e-6,
                    `${JSON.stringify({ skinning, tangents, name })} component ${i}: ${values[i]} != ${expected[i]}`);
            }
        }
    } finally {
        await browser.close();
    }
});
