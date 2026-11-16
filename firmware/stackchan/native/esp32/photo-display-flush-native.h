#ifndef STACKCHAN_PHOTO_DISPLAY_FLUSH_NATIVE_H
#define STACKCHAN_PHOTO_DISPLAY_FLUSH_NATIVE_H

#if defined(__cplusplus)
extern "C" {
#endif

void stackchanPhotoFlushArm(int armed, void* theMachine);
void stackchanPhotoSetOnDrawFrame(int frame);
void stackchanPhotoPocoRectangleFillTrace(void* poco, const char* phase, int inX, int inY, int inW, int inH, int clipX, int clipY, int clipW, int clipH, void* pc, int pcH);
void stackchanPhotoPocoDrawingBeginDirtyTrace(void* poco, int x, int y, int w, int h);
void stackchanPhotoPocoDrawingEndFillVerify(void* poco);
void stackchanPhotoFlushSetBlitRect(int x, int y, int w, int h);
void stackchanPhotoPocoBitmapSrc(void* poco, void* srcPixels, int rowPixels, int w, int h);
void stackchanPhotoPocoBitmapDrawEnter(void* poco, int bitsFormat, int expectFormat, int bitW, int bitH, int x, int y, int sx, int sy, int sw, int sh);
void stackchanPhotoPocoBitmapDrawSkip(const char* reason);
void stackchanPhotoPocoBitmapDrawBuild(void* poco, int x, int y, int w, int h);
void stackchanPhotoPocoDisplayListSnap(void* poco, const char* tag, void* pc);
void stackchanPhotoPocoDrawingEndList(void* poco);
void stackchanPhotoPocoRenderCommand(void* poco, int command, int x, int y, int w, int h);
void stackchanPhotoPocoAfterRender(void* poco, int command, void* dst, int rowBytes, int drawW, int drawH, int slabX, int slabY);
void stackchanPhotoFlushIli9341Begin(int x, int y, int w, int h);
void stackchanPhotoFlushIli9341DoSend(void* pixels, int byteLength);
int stackchanPhotoFlushIli9341GetBeginCount(void);
int stackchanPhotoFlushIli9341GetDoSendCount(void);
int stackchanPhotoFlushIli9341GetDoSendBytes(void);

#if defined(__cplusplus)
}
#endif

#endif
