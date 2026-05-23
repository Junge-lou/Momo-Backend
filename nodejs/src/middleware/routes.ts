import Router from"@koa/router";
import { getCommentBySlug, postComment } from "../api/index" // public
import { getAllComments, changeCommentStatus, updateComment, login, getStatsOverview, getUserList, getUserComments, getSettings, updateSettings, changePassword, testEmail, importComments, importSettings, exportSettings, exportComments } from "../api/index" // admin
import fs from "fs";
import path from "path";


const router = new Router();

router.get("/api/comments", getCommentBySlug);
router.post("/api/comments", postComment);

router.get("/admin/settings", getSettings);
router.put("/admin/settings", updateSettings);
router.post("/admin/settings/test-email", testEmail);
router.put("/admin/password", changePassword);

router.get("/admin/comments/list", getAllComments);
router.put("/admin/comments/status", changeCommentStatus);
router.put("/admin/comments/edit", updateComment);
router.post("/admin/login", login);

router.get("/admin/stats/overview", getStatsOverview);
router.get("/admin/stats/users", getUserList);
router.get("/admin/stats/users/comments", getUserComments);

router.post("/admin/data/import/comments", importComments);
router.post("/admin/data/import/settings", importSettings);
router.get("/admin/data/export/settings", exportSettings);
router.get("/admin/data/export/comments", exportComments);

router.get("/*all", async (ctx) => {
  ctx.type = "text/html";
  ctx.body = fs.createReadStream(path.join(__dirname, "../../public/index.html"));
});

export default router;