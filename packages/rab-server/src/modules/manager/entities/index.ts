export * from './manager-profile.entity';
// `manager_venue` (a venue manager's assigned venues) is the input to ResourceScopeService's venue scope, so engine owns
// the entity (engine/ never imports modules/); re-exported here so domain code keeps its import path.
export * from '../../../engine/core-modules/resource-scope/entities/manager-venue.entity';
