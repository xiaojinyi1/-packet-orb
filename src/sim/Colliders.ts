/**
 * 把协议里的碰撞体描述烘焙进 rapier 世界。
 * 静态体只建一次；trimesh 的顶点/索引来自 RoadNetwork 构建期，不再改动。
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { ColliderSpec } from './protocol';

export function createStaticBody(world: RAPIER.World): RAPIER.RigidBody {
  return world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
}

export function addStaticColliders(
  world: RAPIER.World,
  body: RAPIER.RigidBody,
  specs: ColliderSpec[],
): RAPIER.Collider[] {
  const colliders: RAPIER.Collider[] = [];
  for (const spec of specs) {
    let desc: RAPIER.ColliderDesc;
    if (spec.kind === 'trimesh') {
      desc = RAPIER.ColliderDesc.trimesh(
        spec.vertices,
        spec.indices,
        RAPIER.TriMeshFlags.MERGE_DUPLICATE_VERTICES,
      );
    } else {
      desc = RAPIER.ColliderDesc.cuboid(
        spec.halfExtents[0],
        spec.halfExtents[1],
        spec.halfExtents[2],
      )
        .setTranslation(spec.position[0], spec.position[1], spec.position[2])
        .setRotation({
          x: spec.rotation[0],
          y: spec.rotation[1],
          z: spec.rotation[2],
          w: spec.rotation[3],
        });
    }
    desc
      .setFriction(spec.friction)
      .setRestitution(spec.restitution)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max);
    colliders.push(world.createCollider(desc, body));
  }
  return colliders;
}
