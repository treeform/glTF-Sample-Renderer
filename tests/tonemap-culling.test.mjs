import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

// Exercise the real presentation method after a mirrored mesh leaves CW winding.
test('tonemap presents the frame regardless of the previous mesh winding', async () => {
    const source = await readFile(new URL('../source/Renderer/renderer.js', import.meta.url), 'utf8');
    const method = source.slice(source.indexOf('    tonemapPass('), source.indexOf('    splatCompositePass('));
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE });
    try {
        const page = await browser.newPage();
        const pixels = await page.evaluate((method) => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 2;
            const gl = canvas.getContext('webgl2');
            const compile = (type, body) => {
                const shader = gl.createShader(type);
                gl.shaderSource(shader, '#version 300 es\nprecision highp float;\n' + body);
                gl.compileShader(shader);
                if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
                return shader;
            };
            const program = gl.createProgram();
            gl.attachShader(program, compile(gl.VERTEX_SHADER, 'in vec2 a_position; void main(){gl_Position=vec4(a_position,0,1);}'));
            gl.attachShader(program, compile(gl.FRAGMENT_SHADER, 'out vec4 color; void main(){color=vec4(1,0,0,1);}'));
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
            const shader = { program, updateUniform() {},
                getUniformLocation: name => gl.getUniformLocation(program, name),
                getAttributeLocation: name => gl.getAttribLocation(program, name) };
            const renderer = new Function('GL', 'return ({' + method + '});')(gl);
            Object.assign(renderer, { webGl: { context: gl }, pushFragParameterDefines() {},
                shaderCache: { selectShader: () => true, getShaderProgram: () => shader },
                mainTexture: null, mainTonemapTexture: null, splatVBO: gl.createBuffer() });
            gl.bindBuffer(gl.ARRAY_BUFFER, renderer.splatVBO);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
            const results = [];
            for (const winding of [gl.CCW, gl.CW]) {
                gl.clearColor(0, 0, 1, 1);
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.enable(gl.CULL_FACE);
                gl.cullFace(gl.BACK);
                gl.frontFace(winding);
                renderer.tonemapPass({ renderingParameters: { exposure: 1 } }, 0, 0, 2, 2);
                const pixel = new Uint8Array(4);
                gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                if (gl.getError() !== gl.NO_ERROR) throw Error('WebGL error');
                results.push(Array.from(pixel));
            }
            return results;
        }, method);
        assert.deepEqual(pixels, [[255, 0, 0, 255], [255, 0, 0, 255]]);
    } finally {
        await browser.close();
    }
});
