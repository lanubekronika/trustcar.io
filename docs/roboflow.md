Roboflow Labeling + Training Guide (Starter)

Goal: train an object-detection / segmentation model to locate coin (penny/quarter) and tire tread features so you can compute scale and automate tread-depth checks.

1) Collect images
- Capture 200–500 examples of tires with a coin placed in-frame next to the tread. Vary angles, lighting, phone models, distances, and backgrounds.
- Make sure the coin is in focus and in the same plane as the tread for accurate scale.

2) Create a Roboflow project
- Sign up at https://roboflow.com
- Create a new project (Object Detection or Instance Segmentation). Instance segmentation can be more precise for mask-based depth heuristics but object detection is faster.

3) Upload & label
- Upload your images in batches.
- Label two classes at minimum: `coin` and `tread_area`.
- For coarse depth estimation you may also label `groove` or keypoints on treads if visible.

4) Augment and split
- Use Roboflow augmentation (brightness, contrast, blur, rotation) to diversify the dataset.
- Split train/valid/test (80/10/10).

5) Train
- Use Roboflow hosted training or export the dataset to train locally / on SageMaker.
- Choose a backbone: EfficientDet or YOLOv5/YOLOv8 backbones are good for mobile & server inference.

6) Evaluate
- Inspect precision/recall and mAP. Adjust labels/augmentation accordingly.

7) Inference & scale
- On inference, detect `coin` bounding box. Compute pixel diameter from bounding box width (or segmentation mask), then mm/pixel = coin_diameter_mm / pixel_diameter.
- Detect `tread_area` or use segmentation to isolate the tread. Compute local depth heuristics from profile sampling or use a specialized model to predict depth in mm (advanced).

8) Deployment
- Export model to a hosted inference endpoint (Roboflow Inference) or to TensorFlow Lite / ONNX for on-device inference.

Starter code notes
- For prototype, use the server-side or client-side OpenCV-based coin detection while you gather labels.
- Then switch to model inference for more robust results.

Roboflow resources
- Roboflow docs: https://docs.roboflow.com
- Roboflow export formats: TF/TFLite, ONNX, CoreML, and hosted endpoints.

If you want, I can:
- Create a small labeling template (CSV) and sample images to upload to Roboflow.
- Add a server-side inference wrapper that calls a hosted Roboflow model.
- Add a mobile on-device TFLite example.
