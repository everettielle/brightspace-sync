import {
  BrightspaceClient,
  collectContentFileTopics,
  defaultSessionPath,
  readBrowserSession,
} from "brightspace-sync";

const baseUrl = process.env.BRIGHTSPACE_BASE_URL;
if (!baseUrl) throw new Error("Set BRIGHTSPACE_BASE_URL");

const { auth } = await readBrowserSession(defaultSessionPath(), baseUrl);
const client = new BrightspaceClient({ baseUrl, auth });
const versions = await client.discoverVersions();
const enrollments = await client.getMyCourseOfferings(versions.lp);

for (const enrollment of enrollments) {
  const toc = await client.getContentToc(versions.le, enrollment.OrgUnit.Id);
  console.log(
    JSON.stringify({
      courseId: enrollment.OrgUnit.Id,
      courseCode: enrollment.OrgUnit.Code,
      downloadableFiles: collectContentFileTopics(toc).length,
    }),
  );
}
