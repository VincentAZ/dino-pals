// Aerial perspective: replaces three.js' exponential-squared fog with a height
// fog — the fog's density falls off exponentially with altitude, integrated
// along each view ray — so lowlands and valleys sit in soft haze while the
// volcano and the snowy peaks stay crisp against the sky. Pure ShaderChunk
// patch (no extra uniforms), applied to every fogged material, including the
// custom grass / water / impostor shaders. Imported once for its side effect.
import * as THREE from 'three';

/** scale height of the fog (m) */
const FOG_SCALE_HEIGHT = 110;

THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying float vFogHeight;
#endif`;

THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // world-space height of the vertex (the view matrix is rigid)
  vFogHeight = dot( viewMatrix[ 1 ].xyz, mvPosition.xyz - viewMatrix[ 3 ].xyz );
#endif`;

THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying float vFogHeight;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;

THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    // mean of exp(-h / H) along the ray from the camera to this fragment
    float fK = ${(1 / FOG_SCALE_HEIGHT).toFixed(6)};
    float fH0 = max( cameraPosition.y, -20.0 ), fH1 = max( vFogHeight, -20.0 );
    float fDh = fH1 - fH0;
    float fA = exp( - fH0 * fK ), fB = exp( - fH1 * fK );
    float fMean = abs( fDh ) > 0.5 ? ( fA - fB ) / ( fDh * fK ) : fA;
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth * clamp( fMean, 0.04, 1.6 ) );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;

export const ATMOSPHERE = true;
