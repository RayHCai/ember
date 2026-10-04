import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';

const PAPER = 0xfff6ef;
const RELIEF = 3.4;
const BURN_SECONDS = 1.8;
const SWOOP_SECONDS = 2.8;

const canvas = document.querySelector('#bg');
const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Shared by the map, the embers and the curtain so all three agree on where the fire is.
const FIELD = /* glsl */ `
    const float CELL = 9.0;
    const float PERIOD = 16.0;
    const float REACH = 4.6;

    float hash(vec2 p) {
        vec3 q = fract(vec3(p.xyx) * 0.1031);
        q += dot(q, q.yzx + 33.33);
        return fract((q.x + q.y) * q.z);
    }

    float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
            mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
            mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
            f.y
        );
    }

    float fbm(vec2 p) {
        float amplitude = 0.5;
        float sum = 0.0;
        for (int octave = 0; octave < 5; octave++) {
            sum += amplitude * noise(p);
            p = p * 2.03 + 17.1;
            amplitude *= 0.5;
        }
        return sum;
    }

    float terrain(vec2 w) {
        return fbm(w * 0.17);
    }

    // x: flame front, y: burned ground behind it, z: wide glow around the front.
    vec3 fire(vec2 w, float t) {
        float wobble = noise(w * 0.55) * 1.7 + noise(w * 1.9) * 0.45;
        vec2 cell = floor(w / CELL);
        vec3 sum = vec3(0.0);
        for (int j = -1; j <= 1; j++) {
            for (int i = -1; i <= 1; i++) {
                vec2 c = cell + vec2(float(i), float(j));
                float cycle = t / PERIOD + hash(c + 3.1);
                float phase = fract(cycle);
                vec2 key = c + floor(cycle) * 17.0;
                float live = step(0.3, hash(key + 9.7))
                    * smoothstep(0.0, 0.05, phase)
                    * (1.0 - smoothstep(0.72, 1.0, phase));
                vec2 origin = (c + 0.25 + 0.5 * vec2(hash(key + 1.3), hash(key + 5.9))) * CELL;
                float radius = REACH * (1.0 - (1.0 - phase) * (1.0 - phase));
                float d = distance(w, origin) + wobble - 1.1 - radius;
                sum = max(sum, live * vec3(
                    exp(-d * d * 10.0),
                    1.0 - smoothstep(-0.4, 0.0, d),
                    exp(-d * d * 1.4)
                ));
            }
        }
        return sum;
    }
`;

function start(surface) {
    const renderer = new THREE.WebGLRenderer({
        canvas: surface,
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
    });
    const small = window.innerWidth < 700;
    renderer.setClearColor(PAPER, 1);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.5 : 1.75));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 80);

    const shared = {
        uTime: { value: 30 },
        uScroll: { value: new THREE.Vector2() },
        uRelief: { value: RELIEF },
    };

    const map = makeMap(shared);
    scene.add(map.mesh);

    const embers = makeEmbers(shared, small ? 3000 : 7000, renderer.getPixelRatio());
    scene.add(embers);

    const curtain = makeCurtain(shared);
    scene.add(curtain.mesh);

    const from = { position: new THREE.Vector3(0, 15, 2.5), target: new THREE.Vector3(0, 0, 0) };
    const to = { position: new THREE.Vector3(0, 7.5, 11), target: new THREE.Vector3(0, 0, -2) };
    const position = new THREE.Vector3();
    const target = new THREE.Vector3();

    let pointerX = 0;
    let pointerY = 0;
    let driftX = 0;
    let driftY = 0;
    window.addEventListener('pointermove', (event) => {
        pointerX = event.clientX / window.innerWidth - 0.5;
        pointerY = event.clientY / window.innerHeight - 0.5;
    });

    function resize() {
        const width = window.innerWidth;
        const height = Math.max(window.innerHeight, 1);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        curtain.uniforms.uAspect.value = width / height;
        renderer.setSize(width, height, false);
    }

    function place(swoop) {
        const eased = 1 - Math.pow(1 - swoop, 3);
        position.lerpVectors(from.position, to.position, eased);
        target.lerpVectors(from.target, to.target, eased);
        camera.position.set(position.x + driftX * 1.6, position.y - driftY * 0.8, position.z);
        camera.lookAt(target);
    }

    function announce() {
        const late = document.body.classList.contains('lit');
        if (late) surface.style.transition = 'opacity 1s ease';
        document.body.classList.add('gl');
        window.dispatchEvent(new Event('ember:scene-ready'));
        return late;
    }

    resize();

    if (still) {
        curtain.mesh.visible = false;
        const draw = () => {
            resize();
            place(1);
            renderer.render(scene, camera);
        };
        draw();
        window.addEventListener('resize', draw);
        announce();
        return;
    }

    window.addEventListener('resize', resize);

    const clock = new THREE.Clock();
    let ignitedAt = null;
    let flare = 0;
    let announced = false;
    let frame = 0;

    window.addEventListener('ember:ignite', () => {
        if (ignitedAt === null) ignitedAt = clock.elapsedTime;
    });
    window.addEventListener('ember:flare', () => {
        flare = 1;
    });

    function tick() {
        frame = requestAnimationFrame(tick);
        if (document.hidden) return;
        const delta = Math.min(clock.getDelta(), 0.1);
        const time = clock.elapsedTime;

        shared.uTime.value = 30 + time;
        shared.uScroll.value.set(time * 0.05, time * -0.22);

        flare *= Math.exp(-delta * 1.4);
        map.uniforms.uFlare.value = flare;

        const since = ignitedAt === null ? 0 : time - ignitedAt;
        const burn = Math.min(since / BURN_SECONDS, 1);
        curtain.uniforms.uBurn.value = burn * burn * (3 - 2 * burn);
        curtain.mesh.visible = burn < 1;

        driftX += (pointerX - driftX) * 0.04;
        driftY += (pointerY - driftY) * 0.04;
        place(Math.min(since / SWOOP_SECONDS, 1));

        renderer.render(scene, camera);

        if (!announced) {
            announced = true;
            // The page already lifted its own curtain, so skip the burn and just fade in.
            if (announce()) ignitedAt = time - SWOOP_SECONDS;
        }
    }

    tick();

    window.addEventListener('pagehide', () => {
        cancelAnimationFrame(frame);
        renderer.dispose();
    });
}

function makeMap(shared) {
    const geometry = new THREE.PlaneGeometry(96, 64, 320, 214);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, 0, -14);

    const uniforms = {
        ...shared,
        uFlare: { value: 0 },
        // Shaders here write sRGB directly, so the fog is given as sRGB too.
        uFog: { value: new THREE.Vector3(1.0, 0.965, 0.937) },
    };

    const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: /* glsl */ `
            uniform vec2 uScroll;
            uniform float uRelief;
            varying vec2 vWorld;
            varying float vShade;
            varying float vDistance;
            ${FIELD}
            void main() {
                vec2 w = position.xz + uScroll;
                float e = 0.35;
                vec3 slope = normalize(vec3(
                    terrain(w - vec2(e, 0.0)) - terrain(w + vec2(e, 0.0)),
                    2.0 * e / uRelief,
                    terrain(w - vec2(0.0, e)) - terrain(w + vec2(0.0, e))
                ));
                vShade = dot(slope, normalize(vec3(-0.5, 0.7, 0.4)));
                vec3 lifted = vec3(position.x, (terrain(w) - 0.5) * uRelief, position.z);
                vec4 view = modelViewMatrix * vec4(lifted, 1.0);
                vDistance = -view.z;
                vWorld = w;
                gl_Position = projectionMatrix * view;
            }
        `,
        fragmentShader: /* glsl */ `
            uniform float uTime;
            uniform float uFlare;
            uniform vec3 uFog;
            varying vec2 vWorld;
            varying float vShade;
            varying float vDistance;
            ${FIELD}

            float contour(float level) {
                float width = fwidth(level);
                float line = 1.0 - smoothstep(0.0, 1.3, abs(fract(level - 0.5) - 0.5) / width);
                return line * (1.0 - smoothstep(0.2, 0.55, width));
            }

            void main() {
                float h = terrain(vWorld);
                vec3 color = mix(vec3(0.995, 0.925, 0.875), vec3(1.0, 0.985, 0.97), smoothstep(0.25, 0.75, h));
                color *= 0.93 + 0.09 * vShade;

                float lines = contour(h * 26.0) * 0.3 + contour(h * 5.2) * 0.45;
                color = mix(color, vec3(0.80, 0.40, 0.30), lines);

                vec3 f = fire(vWorld, uTime);
                float ash = 0.4 + 0.25 * noise(vWorld * 6.0);
                color = mix(color, vec3(0.94, 0.38, 0.27), f.y * ash);
                color = mix(color, vec3(0.62, 0.13, 0.08), f.y * lines * 0.8);
                color = mix(color, vec3(1.0, 0.56, 0.14), min(f.z * (0.34 + uFlare * 0.5), 1.0));

                float flicker = 0.7 + 0.6 * noise(vWorld * 3.5 + vec2(0.0, uTime * 2.5));
                float front = min(f.x * flicker * (1.0 + uFlare), 1.0);
                vec3 flame = mix(vec3(0.90, 0.13, 0.09), vec3(1.0, 0.50, 0.08), smoothstep(0.2, 0.7, front));
                flame = mix(flame, vec3(1.0, 0.88, 0.45), smoothstep(0.75, 1.0, front));
                color = mix(color, flame, smoothstep(0.05, 0.5, front));

                color = mix(color, uFog, smoothstep(16.0, 33.0, vDistance));
                gl_FragColor = vec4(color, 1.0);
            }
        `,
    });

    return { mesh: new THREE.Mesh(geometry, material), uniforms };
}

function makeEmbers(shared, count, pixelRatio) {
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
        positions[index * 3] = (Math.random() - 0.5) * 52;
        positions[index * 3 + 2] = -28 + Math.random() * 37;
        seeds[index] = Math.random();
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

    const material = new THREE.ShaderMaterial({
        uniforms: { ...shared, uPixel: { value: pixelRatio } },
        vertexShader: /* glsl */ `
            attribute float aSeed;
            uniform float uTime;
            uniform vec2 uScroll;
            uniform float uRelief;
            uniform float uPixel;
            varying float vAlpha;
            varying float vHeat;
            ${FIELD}
            void main() {
                vec2 w = position.xz + uScroll;
                float strength = fire(w, uTime).z;
                float phase = fract(uTime * (0.22 + 0.4 * fract(aSeed * 7.31)) + aSeed);
                float sway = uTime * 1.3 + aSeed * 40.0;
                vec3 lifted = vec3(
                    position.x + sin(sway) * 0.3 * phase,
                    (terrain(w) - 0.5) * uRelief + 0.05 + phase * (0.6 + phase * 2.6),
                    position.z + cos(sway * 0.8) * 0.3 * phase
                );
                vec4 view = modelViewMatrix * vec4(lifted, 1.0);
                gl_Position = projectionMatrix * view;
                vHeat = 1.0 - phase;
                vAlpha = strength * vHeat * smoothstep(0.0, 0.08, phase);
                vAlpha *= 1.0 - smoothstep(16.0, 30.0, -view.z);
                float size = (0.35 + 0.9 * fract(aSeed * 13.7)) * mix(1.0, 0.3, phase);
                gl_PointSize = uPixel * size * (150.0 / -view.z) * step(0.03, vAlpha);
            }
        `,
        fragmentShader: /* glsl */ `
            varying float vAlpha;
            varying float vHeat;
            void main() {
                float soft = 1.0 - smoothstep(0.0, 0.5, length(gl_PointCoord - 0.5));
                vec3 color = mix(vec3(0.88, 0.14, 0.08), vec3(1.0, 0.72, 0.2), vHeat * vHeat);
                gl_FragColor = vec4(color, min(soft * vAlpha * 1.5, 1.0));
            }
        `,
        transparent: true,
        depthWrite: false,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    return points;
}

function makeCurtain(shared) {
    const uniforms = {
        uTime: shared.uTime,
        uBurn: { value: 0 },
        uAspect: { value: 1 },
    };

    const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: /* glsl */ `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position.xy, 0.0, 1.0);
            }
        `,
        fragmentShader: /* glsl */ `
            uniform float uTime;
            uniform float uBurn;
            uniform float uAspect;
            varying vec2 vUv;
            ${FIELD}
            void main() {
                vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
                float reach = length(vec2(uAspect, 1.0)) * 0.5;
                float ragged = fbm(p * 3.2 + 4.0) * 0.5 + noise(p * 14.0 + uTime * 0.6) * 0.06;
                float d = length(p) + ragged - mix(-0.1, reach + 0.75, uBurn);
                if (d < -0.05) discard;
                float heat = 1.0 - smoothstep(0.0, 0.11, d);
                vec3 color = mix(vec3(0.898, 0.196, 0.122), vec3(1.0, 0.62, 0.12), heat);
                color = mix(color, vec3(1.0, 0.93, 0.6), smoothstep(0.6, 1.0, heat));
                gl_FragColor = vec4(color, smoothstep(-0.05, -0.01, d));
            }
        `,
        transparent: true,
        depthTest: false,
        depthWrite: false,
    });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    return { mesh, uniforms };
}

if (canvas) {
    try {
        start(canvas);
    } catch {
        // No WebGL: the page keeps its plain paper background.
    }
}
