#!/usr/bin/env python3
"""Build realistic low-poly gun models for the cod game.

Run:  blender -b -P build_guns.py -- /output/dir

Conventions:
  - Blender +Y = muzzle direction  ->  exports to glTF -Z (the game's forward)
  - Real-world sizes in meters (game fitGun() rescales but keeps proportions)
  - Each gun gets an Empty named 'AimPoint' at the sight's optical center,
    +Y-forward of it, so the game can align ADS to the red dot / scope.
Parts are simple primitives; realism comes from proportions and materials.
"""
import bpy, math, sys, os

OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "."

# ---------------- helpers ----------------
def clear():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for m in list(bpy.data.meshes): bpy.data.meshes.remove(m)
    for m in list(bpy.data.materials): bpy.data.materials.remove(m)
    MATS.clear()

MATS = {}
def mat(name, color, metallic=0.0, rough=0.6, emit=None, emit_strength=0.0, alpha=1.0):
    if name in MATS: return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = rough
    if emit:
        bsdf.inputs["Emission Color"].default_value = (*emit, 1)
        bsdf.inputs["Emission Strength"].default_value = emit_strength
    if alpha < 1.0:
        bsdf.inputs["Alpha"].default_value = alpha
        try: m.blend_method = "BLEND"
        except Exception: pass
        try: m.surface_render_method = "BLENDED"
        except Exception: pass
    MATS[name] = m
    return m

def M():
    return {
        "steel":   mat("steel",   (0.17, 0.17, 0.20), 0.5, 0.42),
        "dark":    mat("dark",    (0.06, 0.06, 0.07), 0.35, 0.5),
        "poly":    mat("poly",    (0.10, 0.10, 0.11), 0.0, 0.8),
        "wood":    mat("wood",    (0.28, 0.14, 0.055), 0.0, 0.55),
        "wooddk":  mat("wooddk",  (0.20, 0.095, 0.04), 0.0, 0.6),
        "gold":    mat("gold",    (0.85, 0.65, 0.2), 0.5, 0.3),
        "greenpoly": mat("greenpoly", (0.16, 0.20, 0.13), 0.0, 0.7),
        "tanpoly": mat("tanpoly", (0.35, 0.30, 0.22), 0.0, 0.7),
        "glass":   mat("glass",   (0.02, 0.05, 0.08), 0.3, 0.1),
        "reddot":  mat("reddot",  (0.9, 0.0, 0.0), 0.0, 0.4, emit=(1.0, 0.0, 0.0), emit_strength=1.5),
        "lens":    mat("lens",    (0.30, 0.55, 0.75), 0.3, 0.05, alpha=0.22),
    }

def box(name, sx, sy, sz, x, y, z, material, rx=0, ry=0, rz=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, z), rotation=(rx, ry, rz))
    o = bpy.context.active_object
    o.name = name
    o.scale = (sx, sy, sz)
    o.data.materials.append(material)
    return o

def cyl(name, r, depth, x, y, z, material, axis="Y", verts=16, r2=None):
    rot = {"Y": (math.pi / 2, 0, 0), "X": (0, math.pi / 2, 0), "Z": (0, 0, 0)}[axis]
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=depth, vertices=verts, location=(x, y, z), rotation=rot)
    else:
        bpy.ops.mesh.primitive_cone_add(radius1=r, radius2=r2, depth=depth, vertices=verts, location=(x, y, z), rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.data.materials.append(material)
    return o

def empty(name, x, y, z):
    bpy.ops.object.empty_add(location=(x, y, z))
    o = bpy.context.active_object
    o.name = name
    return o

def export(objs, path):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs: o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True, export_apply=True)
    print("exported", path, f"({len(objs)} objects)")

# ---------------- red dot sight (shared) ----------------
def red_dot_sight(objs, m, y, z, compact=False, mount_h=0.016):
    """Cronen Mini Pro style: square open-frame reflex with a wide glass pane.
    (y,z) = optical center of the glass. Adds AimPoint empty."""
    s = 0.7 if compact else 1.0
    W = 0.017 * s   # half-width of the window
    H = 0.013 * s   # half-height of the window
    post = 0.004 * s
    depth = 0.016 * s
    base_z = z - H - 0.008 * s
    # base housing (chunky bottom body) + mount riser
    objs.append(box("rd_base", (W + post) * 2, 0.036 * s, 0.014 * s, 0, y, base_z, m["poly"]))
    objs.append(box("rd_mount", 0.020 * s, 0.030 * s, mount_h, 0, y, base_z - 0.007 * s - mount_h / 2 + 0.002, m["dark"]))
    # side posts + thin top bar (square frame)
    objs.append(box("rd_post_l", post, depth, H * 2 + 0.006 * s, -(W + post / 2), y, z, m["poly"]))
    objs.append(box("rd_post_r", post, depth, H * 2 + 0.006 * s, +(W + post / 2), y, z, m["poly"]))
    objs.append(box("rd_top", (W + post) * 2, depth, post, 0, y, z + H + 0.003 * s + post / 2, m["poly"]))
    # wide glass pane, tilted slightly back like a real reflex lens
    objs.append(box("rd_glass", W * 2, 0.0015, H * 2, 0, y, z, m["lens"], rx=-0.12))
    # the red dot: emissive disc floating at the optical center, eye side of the glass
    objs.append(cyl("rd_dot", 0.0009 * s, 0.0022, 0, y - 0.0045, z, m["reddot"], verts=12))
    # brightness button nub on the left post
    objs.append(box("rd_btn", 0.003, 0.010 * s, 0.010 * s, -(W + post + 0.0015), y, z - H / 2, m["dark"]))
    objs.append(empty("AimPoint", 0, y, z))

# ---------------- AK-47 ----------------
def build_ak47(path):
    clear(); m = M(); objs = []
    BAR = 0.045  # barrel axis height above origin
    # receiver (stamped box) + dust cover (slightly rounded top via bevel-ish thinner box)
    objs.append(box("receiver", 0.036, 0.24, 0.062, 0, 0.02, BAR - 0.014, m["steel"]))
    objs.append(box("dustcover", 0.034, 0.22, 0.020, 0, 0.03, BAR + 0.016, m["steel"]))
    # barrel assembly: gas tube, muzzle brake (irons removed — red dot equipped)
    objs.append(cyl("barrel", 0.0105, 0.42, 0, 0.30, BAR, m["dark"]))
    objs.append(cyl("gastube", 0.009, 0.21, 0, 0.235, BAR + 0.028, m["steel"]))
    objs.append(cyl("gasblock", 0.014, 0.03, 0, 0.315, BAR + 0.014, m["dark"], axis="Z"))
    objs.append(cyl("muzzle", 0.012, 0.035, 0, 0.522, BAR, m["dark"], r2=0.009))
    # wooden handguard (upper + lower)
    objs.append(box("handguard_lo", 0.040, 0.165, 0.036, 0, 0.225, BAR - 0.016, m["wood"]))
    objs.append(box("handguard_hi", 0.034, 0.125, 0.020, 0, 0.215, BAR + 0.026, m["wooddk"]))
    # iconic curved magazine: segments sweep down-forward (banana curve opens to the rear)
    cx, cz = 0.045, BAR - 0.048
    ang = 0.30
    for i in range(4):
        a = ang * (i + 0.5)
        objs.append(box(f"mag{i}", 0.028, 0.055, 0.052, 0, cx, cz, m["steel"], rx=a))
        cx += 0.046 * math.sin(a + ang / 2) * 0.35 + 0.006
        cz -= 0.046 * math.cos(a) * 0.92
    # pistol grip (wood) + trigger + guard
    objs.append(box("grip", 0.030, 0.038, 0.085, 0, -0.085, BAR - 0.070, m["wooddk"], rx=0.35))
    objs.append(box("trigguard", 0.020, 0.070, 0.006, 0, -0.035, BAR - 0.052, m["steel"]))
    objs.append(box("trigger", 0.006, 0.008, 0.026, 0, -0.032, BAR - 0.040, m["steel"], rx=0.2))
    # wooden buttstock (tapers down-back)
    objs.append(box("stock", 0.036, 0.20, 0.055, 0, -0.185, BAR - 0.020, m["wood"], rx=0.10))
    objs.append(box("buttplate", 0.038, 0.012, 0.062, 0, -0.283, BAR - 0.030, m["dark"], rx=0.10))
    # charging handle
    objs.append(box("chandle", 0.016, 0.025, 0.012, 0.026, 0.075, BAR + 0.006, m["dark"]))
    # red dot on the dust cover (dust cover top ≈ BAR+0.026)
    red_dot_sight(objs, m, 0.02, BAR + 0.048, mount_h=0.014)
    objs.append(empty("GripR", 0, -0.085, BAR - 0.075))
    objs.append(empty("GripL", 0, 0.235, BAR - 0.035))
    export(objs, path)

# ---------------- Pump shotgun (870 style) ----------------
def build_shotgun(path):
    clear(); m = M(); objs = []
    BAR = 0.04
    objs.append(box("receiver", 0.038, 0.17, 0.058, 0, -0.02, BAR - 0.010, m["steel"]))
    objs.append(cyl("barrel", 0.0115, 0.48, 0, 0.30, BAR + 0.008, m["dark"]))
    objs.append(cyl("magtube", 0.0105, 0.40, 0, 0.25, BAR - 0.026, m["dark"]))
    # ribbed pump forend
    objs.append(cyl("pump", 0.021, 0.13, 0, 0.20, BAR - 0.026, m["poly"], verts=12))
    for i in range(5):
        objs.append(box(f"rib{i}", 0.046, 0.006, 0.030, 0, 0.152 + i * 0.024, BAR - 0.026, m["dark"]))
    # loading port + ejection port hints
    objs.append(box("ejport", 0.004, 0.055, 0.020, 0.020, -0.005, BAR + 0.004, m["dark"]))
    # trigger group
    objs.append(box("trigguard", 0.018, 0.075, 0.008, 0, -0.075, BAR - 0.044, m["poly"]))
    objs.append(box("trigger", 0.006, 0.008, 0.024, 0, -0.068, BAR - 0.032, m["steel"], rx=0.2))
    # synthetic stock with pistol-grip-ish comb
    objs.append(box("stock_wrist", 0.034, 0.10, 0.048, 0, -0.135, BAR - 0.022, m["poly"], rx=0.22))
    objs.append(box("stock", 0.036, 0.16, 0.058, 0, -0.245, BAR - 0.038, m["poly"], rx=0.10))
    objs.append(box("buttpad", 0.038, 0.014, 0.068, 0, -0.324, BAR - 0.048, m["dark"], rx=0.10))
    # receiver-top red dot (receiver top ≈ BAR+0.019)
    red_dot_sight(objs, m, -0.02, BAR + 0.038, mount_h=0.012)
    objs.append(empty("GripR", 0, -0.115, BAR - 0.045))
    objs.append(empty("GripL", 0, 0.20, BAR - 0.045))
    export(objs, path)

# ---------------- Bolt sniper (AWM style) ----------------
def build_sniper(path):
    clear(); m = M(); objs = []
    BAR = 0.05
    objs.append(box("receiver", 0.040, 0.26, 0.062, 0, -0.01, BAR - 0.012, m["steel"]))
    objs.append(cyl("barrel", 0.013, 0.55, 0, 0.40, BAR, m["dark"]))
    objs.append(cyl("brake", 0.019, 0.07, 0, 0.705, BAR, m["dark"], verts=12))
    for i in range(3):
        objs.append(box(f"brakeslot{i}", 0.042, 0.008, 0.012, 0, 0.685 + i * 0.018, BAR + 0.012, m["steel"]))
    # green polymer stock: fore, cheek, butt + thumbhole gap suggestion
    objs.append(box("fore", 0.042, 0.30, 0.055, 0, 0.19, BAR - 0.034, m["greenpoly"]))
    objs.append(box("mid", 0.040, 0.16, 0.075, 0, -0.10, BAR - 0.052, m["greenpoly"], rx=0.10))
    objs.append(box("cheek", 0.036, 0.15, 0.045, 0, -0.26, BAR + 0.012, m["greenpoly"]))
    objs.append(box("butt", 0.040, 0.17, 0.095, 0, -0.30, BAR - 0.045, m["greenpoly"], rx=0.05))
    objs.append(box("buttpad", 0.042, 0.014, 0.100, 0, -0.385, BAR - 0.045, m["dark"]))
    objs.append(box("grip", 0.030, 0.036, 0.080, 0, -0.115, BAR - 0.095, m["greenpoly"], rx=0.42))
    # box magazine + trigger
    objs.append(box("mag", 0.032, 0.075, 0.055, 0, 0.015, BAR - 0.070, m["dark"], rx=0.06))
    objs.append(box("trigguard", 0.018, 0.070, 0.007, 0, -0.062, BAR - 0.068, m["dark"]))
    objs.append(box("trigger", 0.006, 0.008, 0.026, 0, -0.055, BAR - 0.052, m["steel"], rx=0.2))
    # bolt handle (knob out right side)
    objs.append(cyl("bolt", 0.008, 0.05, 0.038, -0.045, BAR + 0.012, m["steel"], axis="X"))
    objs.append(cyl("boltknob", 0.013, 0.016, 0.065, -0.045, BAR + 0.012, m["dark"], axis="X", verts=10))
    # big scope: main tube + objective bell + ocular + turrets + rings
    SC = BAR + 0.070
    objs.append(cyl("scope_tube", 0.017, 0.20, 0, 0.03, SC, m["poly"], verts=20))
    objs.append(cyl("scope_obj", 0.028, 0.09, 0, 0.16, SC, m["poly"], verts=20, r2=0.017))
    objs.append(cyl("scope_objlens", 0.024, 0.004, 0, 0.203, SC, m["lens"], verts=20))
    objs.append(cyl("scope_ocu", 0.021, 0.06, 0, -0.09, SC, m["poly"], verts=20))
    objs.append(cyl("scope_oculens", 0.017, 0.003, 0, -0.118, SC, m["lens"], verts=20))
    objs.append(cyl("turret_top", 0.010, 0.018, 0, 0.02, SC + 0.024, m["dark"], axis="Z", verts=12))
    objs.append(cyl("turret_side", 0.010, 0.018, 0.024, 0.02, SC, m["dark"], axis="X", verts=12))
    for ry in (0.10, -0.045):
        objs.append(box(f"ring{ry}", 0.012, 0.018, 0.030, 0, ry, BAR + 0.045, m["dark"]))
    objs.append(empty("AimPoint", 0, -0.09, SC))
    objs.append(empty("GripR", 0, -0.115, BAR - 0.085))
    objs.append(empty("GripL", 0, 0.21, BAR - 0.055))
    export(objs, path)

# ---------------- Desert Eagle ----------------
def build_deagle(path):
    clear(); m = M(); objs = []
    m = dict(m); m["steel"] = mat("steel_lt", (0.46, 0.47, 0.50), 0.45, 0.38)
    BAR = 0.02
    # slide: tall flat-sided profile, brushed steel
    objs.append(box("slide", 0.030, 0.220, 0.042, 0, 0.005, BAR + 0.020, m["steel"]))
    objs.append(box("slide_top", 0.020, 0.220, 0.014, 0, 0.005, BAR + 0.046, m["steel"]))
    # slide serrations (rear)
    for i in range(4):
        objs.append(box(f"serr{i}", 0.032, 0.004, 0.032, 0, -0.078 + i * 0.010, BAR + 0.020, m["dark"]))
    # big bore
    objs.append(cyl("bore", 0.013, 0.018, 0, 0.112, BAR + 0.024, m["dark"]))
    # frame + short accessory rail
    objs.append(box("frame", 0.028, 0.190, 0.026, 0, -0.005, BAR - 0.010, m["steel"]))
    objs.append(box("rail", 0.024, 0.080, 0.008, 0, 0.055, BAR - 0.025, m["dark"]))
    # grip (rubberized), raked back
    objs.append(box("grip", 0.032, 0.040, 0.095, 0, -0.072, BAR - 0.062, m["poly"], rx=0.28))
    # removable magazine: body inside the grip + baseplate flush with the grip bottom
    objs.append(box("mag0", 0.024, 0.030, 0.088, 0, -0.070, BAR - 0.064, m["dark"], rx=0.28))
    objs.append(box("mag1", 0.030, 0.040, 0.010, 0, -0.084, BAR - 0.112, m["dark"], rx=0.28))
    # trigger + guard (front bar + bottom bar joining frame to grip)
    objs.append(box("trigguard_f", 0.014, 0.008, 0.036, 0, -0.008, BAR - 0.040, m["steel"]))
    objs.append(box("trigguard_b", 0.014, 0.052, 0.008, 0, -0.032, BAR - 0.056, m["steel"]))
    objs.append(box("trigger", 0.006, 0.007, 0.022, 0, -0.024, BAR - 0.036, m["dark"], rx=0.25))
    # hammer at slide rear
    objs.append(box("hammer", 0.010, 0.014, 0.018, 0, -0.112, BAR + 0.016, m["dark"], rx=-0.45))
    # compact reflex red dot mid-slide
    red_dot_sight(objs, m, 0.02, BAR + 0.072, compact=True, mount_h=0.014)
    objs.append(empty("GripR", 0, -0.072, BAR - 0.062))
    objs.append(empty("GripL", -0.012, -0.078, BAR - 0.085))
    export(objs, path)

build_ak47(os.path.join(OUT, "rifle.glb"))
build_shotgun(os.path.join(OUT, "shotgun.glb"))
build_sniper(os.path.join(OUT, "sniper.glb"))
build_deagle(os.path.join(OUT, "deagle.glb"))
print("ALL GUNS BUILT")
